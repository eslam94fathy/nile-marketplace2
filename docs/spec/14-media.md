# Spec 14 — media

Status: **v1.2 APPROVED (2026-10-21).** v1.2: ME-14 sellers upload return photos (§7.2). v1.1: R2-P1 implementation clarifications ME-7…ME-13 (§7.1). Changes from now on need explicit approval and a version bump. Release 2. Inputs: `00-overview.md` v2.0 §10 (R-1, R-2, R-9), `01-api-conventions.md` v1.4. §7 ME-1…ME-6 answered 2026-10-20 (every recommendation accepted).
Conventions: `01-api-conventions.md`. Events: `02-events.md` (v1.2 adds the media events).

## 1. Scope & owned tables

Images uploaded by users, stored in **object storage**: S3 behind CloudFront in AWS, MinIO locally and in tests. The api never receives image bytes. Clients upload straight to storage with a short-lived presigned POST, then tell the api the upload is complete. The worker verifies the image, strips its metadata and re-encodes it to fixed WebP sizes (R-1).
Tables: `media_objects`.
Depends on: nothing. Owning modules (catalog, support, reviews, returns) call `claim` / `release` (§2) and keep their own reference rows with an FK to `media_objects.id` (`ON DELETE RESTRICT`).

Enums:
- `MediaPurpose`: `product_image, category_image, support_attachment, review_image, return_photo`
- `MediaStatus`: `pending, processing, ready, failed`
- `MediaFailureReason`: `decode_failed, unsupported_type, dimensions_out_of_range`
- `ImageSize`: `thumb` (200 px wide), `medium` (600), `large` (1200). Aspect ratio kept, never upscaled (R-1)

Who may upload each purpose (checked against the JWT role at upload time):

| Purpose | Roles | Visibility (ME-1) |
|---|---|---|
| `product_image` | seller | public |
| `category_image` | admin | public |
| `review_image` | customer | public |
| `support_attachment` | customer, seller, admin | **private** |
| `return_photo` | customer, seller (ME-14) | **private** |

Limits:
- **env:** max upload size `MEDIA_MAX_UPLOAD_BYTES` (5 MB, R-1); max `pending` + `processing` uploads per user `MEDIA_MAX_OPEN_UPLOADS_PER_USER` (20).
- **constants:** input types `image/jpeg, image/png, image/webp` (R-1); min 200 × 200 px; max 50 megapixels (decompression-bomb guard); WebP quality 80.

### 1.1 Storage layout
| Prefix | Content | Access |
|---|---|---|
| `uploads/<mediaId>` | The original as uploaded | Private. Deleted after processing; bucket lifecycle rule deletes leftovers after 2 days |
| `public/<mediaId>/<size>.webp` | Processed public images | Read through CloudFront only (Origin Access Control), `Cache-Control: public, max-age=31536000, immutable` |
| `private/<mediaId>/<size>.webp` | Processed private images | Never through the CDN; read through short-lived presigned GET URLs (ME-1) |

Keys never change once written: a media object is immutable, and a new image is a new media object. So CDN caching needs no invalidation. API responses carry URLs, never bucket names or keys.

## 2. Public API (`index.ts`)

| Method | Caller | Notes |
|---|---|---|
| `claim(mediaIds, { purpose, ownerUserId }, trx) → void` | catalog, support, reviews, returns | Locks the rows `FOR UPDATE` in id order. Each must be `ready`, of that `purpose`, uploaded by `ownerUserId`, and not claimed yet, else `422 MEDIA_NOT_ATTACHABLE` with one detail per bad id. Sets `claimed_at`. Category images: any admin's upload may be claimed by any admin (ME-2) |
| `release(mediaIds, trx) → void` | same | Sets `released_at`. The caller has already deleted its own reference row in the same transaction. The cleanup job deletes the media later, unless another FK still references it (UC-ME-4) |
| `getImages(mediaIds, { viewerUserId? }) → Map<mediaId, ImageDto>` | same | One batched read. Public purposes get CDN URLs. Private purposes get presigned GET URLs (TTL `MEDIA_PRIVATE_URL_TTL_SECONDS`), and the **caller** has already authorised the viewer. Ids that aren't `ready` are left out |

```ts
interface ImageDto {               // shared shape, 01-api-conventions §9.1
  id: string;
  urls: { thumb: string; medium: string; large: string };
  width: number; height: number;   // of the processed large image
}
```

## 3. Use cases

### UC-ME-1 Request an upload (api)
1. Check the role for the purpose (§1) → `403 MEDIA_PURPOSE_NOT_ALLOWED`.
2. Count the user's `pending` + `processing` rows. At the limit → `422 MEDIA_OPEN_UPLOAD_LIMIT_REACHED`. A race can exceed the limit by a few rows, which is accepted because it is only a soft cap (rate limited as well).
3. Insert `media_objects` (`status = pending`, `purpose`, `owner_user_id`, `declared_content_type`, `declared_size_bytes`).
4. Build a presigned POST for key `uploads/<mediaId>` with these conditions: exact key, exact `Content-Type`, `content-length-range` `[1, MEDIA_MAX_UPLOAD_BYTES]`, and expiry `MEDIA_UPLOAD_URL_TTL_SECONDS`. Signing is local, so there is no network call.

### UC-ME-2 Complete an upload (api)
1. Load the row of the caller. Missing, or another user's → `404 MEDIA_NOT_FOUND`.
2. Status rules:
   - `processing` or `ready` → `200` with the current state (a retried complete after a lost response)
   - `failed` → `409 MEDIA_INVALID_STATUS`
   - `pending` → continue
3. Outside any transaction: `HEAD uploads/<mediaId>`.
   - Missing → `409 MEDIA_UPLOAD_MISSING`. The client may still upload and retry until the URL expires.
   - Read the first 16 bytes (range GET) and match the magic bytes against the declared type. A size over the limit or a type mismatch → the object is deleted, status `failed` (`unsupported_type`), `422 MEDIA_UPLOAD_INVALID`.
   - A storage error → `503 SERVICE_UNAVAILABLE`.
4. One transaction: conditional `UPDATE … SET status = 'processing' WHERE id = ? AND status = 'pending'` (0 rows → re-read and answer as in step 2) + outbox `media.uploaded`.
5. → `202 MediaDto`. This is real asynchronous work (CLAUDE.md §7): the image is processed by the worker.

### UC-ME-3 Process an image (worker consumer `media.processing` ← `media.uploaded`)
The work runs outside a transaction, through the consumer host's `beforeTransaction` step (P1-I4).
1. The row is not `processing` → ack (done or failed already).
2. Stream `uploads/<mediaId>` into `sharp`, with these settings:
   - `failOn: 'error'` and `limitInputPixels` at 50 MP
   - `rotate()` applies the EXIF orientation, and the output carries **no metadata** (EXIF, GPS, ICC beyond sRGB)
   - every `ImageSize` is written as WebP under `public/` or `private/` (by visibility)
3. Results:
   - **Permanent** failure (cannot decode, or under 200 × 200 / over 50 MP) → status `failed` with the `failure_reason`, original deleted, `media.failed`, ack.
   - **Transient** failure (storage timeout or 5xx) → nack → retry queue, then DLQ.
4. One transaction: status `ready`, `width`, `height`, `processed_at` + outbox `media.ready`. Then the original is deleted (a failed delete is a `warn`; the lifecycle rule removes it).

A redelivery after step 2 rewrites the same keys with the same bytes, which is harmless.

### UC-ME-4 Clean up (worker job, advisory-locked, every `JOB_MEDIA_CLEANUP_INTERVAL_MS`, batches of `MEDIA_CLEANUP_BATCH_SIZE`)
Candidates are read without locks. Each row is then handled in its own short transaction with `FOR UPDATE SKIP LOCKED`:

| Candidate | Action |
|---|---|
| `pending` older than `MEDIA_PENDING_RETENTION_HOURS` (24) | Delete the row, then the upload object |
| `ready` and never claimed, older than `MEDIA_PENDING_RETENTION_HOURS` | Delete the row, then its processed objects |
| `failed` older than `MEDIA_PENDING_RETENTION_HOURS` | Delete the row |
| `released` | Try to delete the row inside a savepoint. An FK violation (`23503` / `23001`), for example an order item snapshot still pointing at it (spec 09 v2.0), → set `retained_at`, keep the objects, never retry. Otherwise delete the objects after commit |

Objects are deleted only **after** the row delete commits. A failed object delete logs `warn MEDIA_OBJECT_DELETE_FAILED` and leaves an orphan object: storage cost only, no broken image. A `processing` row is never a candidate; one stuck for over an hour logs `error MEDIA_PROCESSING_STUCK`.

## 4. Endpoints   auth: customer | seller | admin · rate: `upload` (new class, conventions v1.4 §9.2)

```ts
interface MediaDto {
  id: string; purpose: MediaPurpose; status: MediaStatus;
  failureReason: MediaFailureReason | null;
  image: ImageDto | null;          // only when ready
  createdAt: string;
}
interface UploadTicketDto {
  media: MediaDto;                 // status pending
  upload: { url: string; fields: Record<string, string>; expiresAt: string };  // multipart form POST to storage
}
```

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `POST /media/uploads` | `purpose enum(MediaPurpose)` · `contentType enum('image/jpeg','image/png','image/webp')` · `sizeBytes int(1..MEDIA_MAX_UPLOAD_BYTES)` | `201 UploadTicketDto` | `MEDIA_PURPOSE_NOT_ALLOWED` 403, `MEDIA_OPEN_UPLOAD_LIMIT_REACHED` 422 |
| `POST /media/uploads/:mediaId/complete` | – | `202 MediaDto` (`200` when already processing / ready) | `MEDIA_NOT_FOUND` 404, `MEDIA_UPLOAD_MISSING` 409, `MEDIA_UPLOAD_INVALID` 422, `MEDIA_INVALID_STATUS` 409, `SERVICE_UNAVAILABLE` 503 |
| `GET /media/:mediaId` | – | `200 MediaDto` (the uploader only; for polling until the realtime `media.ready` push, spec 15) | `MEDIA_NOT_FOUND` 404 |

- No `Idempotency-Key`: these requests have no money or stock effect, and a duplicate upload only leaves an unclaimed row that the cleanup job removes.
- Storage bucket CORS allows `POST` from `CORS_ALLOWED_ORIGINS` only (the web client, R-4).

## 5. Events
Published: `media.uploaded` (consumed by media itself, queue `media.processing`), `media.ready`, `media.failed` (consumed by realtime, spec 15, to tell the uploader).
Consumed: `media.uploaded`.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `MEDIA_NOT_FOUND` | 404 | Missing, or uploaded by someone else |
| `MEDIA_PURPOSE_NOT_ALLOWED` | 403 | The role may not upload this purpose |
| `MEDIA_OPEN_UPLOAD_LIMIT_REACHED` | 422 | Too many `pending` / `processing` uploads |
| `MEDIA_UPLOAD_MISSING` | 409 | Complete called before the object reached storage |
| `MEDIA_UPLOAD_INVALID` | 422 | Size over the limit or content not matching the declared type |
| `MEDIA_INVALID_STATUS` | 409 | Complete on a `failed` upload |
| `MEDIA_NOT_ATTACHABLE` | 422 | `claim` on media not `ready`, of another purpose or owner, or already claimed (`details` per id) |

Log event codes: `MEDIA_OBJECT_DELETE_FAILED` (warn), `MEDIA_PROCESSING_STUCK` (error).

Config:
- **api:** `STORAGE_PROVIDER` (`s3` | `minio`), `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ENDPOINT` + `STORAGE_ACCESS_KEY_ID` + `STORAGE_SECRET_ACCESS_KEY` (only when `minio`; in AWS the ECS task role signs), `MEDIA_PUBLIC_BASE_URL` (the CloudFront domain, or the MinIO public URL locally), `MEDIA_MAX_UPLOAD_BYTES`, `MEDIA_UPLOAD_URL_TTL_SECONDS` (300), `MEDIA_PRIVATE_URL_TTL_SECONDS` (600), `MEDIA_MAX_OPEN_UPLOADS_PER_USER`.
- **worker:** the `STORAGE_*` keys, `MEDIA_PENDING_RETENTION_HOURS`, `JOB_MEDIA_CLEANUP_INTERVAL_MS`, `MEDIA_CLEANUP_BATCH_SIZE`.

All keys are required, with no defaults. The `minio`-only keys are required only when the provider is `minio`, the same pattern as `MAILPIT_URL` (P1-Q2). A deployed environment refuses `minio` (F-3 pattern).

## 7. Decisions (answered 2026-10-20)

The user accepted every recommendation (2026-10-20). The table is kept for the reasoning; the answers are logged in `00-overview.md` §10.8.

| # | Topic | Options / recommendation |
|---|---|---|
| ME-1 | Private media (support attachments, return photos can show addresses, receipts, faces) | **Rec:** stored under `private/`, never on the CDN, served by presigned GET URLs (10 min) generated only for viewers the owning module has authorised · or everything public under unguessable URLs (simpler, but a leaked link is readable forever) |
| ME-2 | Who may claim a category image | **Rec:** any admin may attach any admin's `category_image` upload (admins act as one team) · or uploader only |
| ME-3 | What the api returns from `complete` | **Rec:** `202` + `MediaDto` (`processing`), and the web client polls `GET /media/:id` or waits for the socket push · or process synchronously in the api (simpler client, but holds an api request for 1–3 s of CPU) |
| ME-4 | Cleanup of released media still referenced elsewhere | **Rec:** the FK `RESTRICT` decides (UC-ME-4): referenced → kept forever (`retained_at`) · or reference counting in media (needs every owner to report) |
| ME-5 | Orphan objects after a failed delete | **Rec:** accept, with a `warn` log (storage cost only) · or a weekly bucket-listing reconcile job |
| ME-6 | Upload rate limit | **Rec:** new class `upload`, keyed by user id, `RATE_LIMIT_UPLOAD_POINTS` / `_DURATION_SECONDS` (proposed 30 per 10 min) · or reuse `general` |

### 7.1 Clarifications (R2-P1 implementation, confirmed 2026-10-20)

| # | Clarification | Where |
|---|---|---|
| ME-7 | The worker checks the magic bytes **again** before decoding: the presigned form stays valid until it expires, so the object can be replaced after `complete` (e.g. by an SVG or TIFF that `sharp` would otherwise decode). A mismatch → `failed` (`unsupported_type`) | UC-ME-3 |
| ME-8 | Config: rate-limit keys follow the existing naming, `RATE_LIMIT_UPLOAD_POINTS` / `RATE_LIMIT_UPLOAD_WINDOW_SECONDS` (30 per 600 s); the same `_WINDOW_SECONDS` naming applies to the R2 classes of specs 15, 16 and 19. New keys: `STORAGE_HTTP_TIMEOUT_MS` (api, worker; 5000), `STORAGE_PUBLIC_ENDPOINT` (api, MinIO only: the host browsers reach, used to sign presigned URLs, since inside docker-compose the api reaches `minio:9000`). `STORAGE_ENDPOINT` and the static keys belong to MinIO only; with `s3` they are unused. `MEDIA_PUBLIC_BASE_URL` has no trailing `/` and must be https once deployed. In AWS, `STORAGE_PROVIDER` (`s3`), `STORAGE_BUCKET` (`nile-<env>-media`) and `STORAGE_REGION` are derived by Terraform. Cleanup: every hour (`JOB_MEDIA_CLEANUP_INTERVAL_MS` 3600000), batches of 100 | §6 |
| ME-9 | `GET /health/ready` also checks storage (`storage`: a HEAD of the bucket), like every other dependency (CLAUDE.md §12) | – |
| ME-10 | `sizeBytes` above `MEDIA_MAX_UPLOAD_BYTES` → `400 VALIDATION_FAILED` (detail on `sizeBytes`). The declared size is informational; the size actually enforced is the presigned `content-length-range` | UC-ME-1 |
| ME-11 | `claim` details: `field` `mediaIds[<index>]`, `constraint` one of `not_found` (missing or another user's: not told apart), `not_ready`, `wrong_purpose`, `already_claimed`, `duplicate`, `value` the id. `release` ignores ids that aren't claimed. `getImages` takes no viewer: the caller has authorised it | §2 |
| ME-12 | Processing: an original missing while `processing` (e.g. removed by the lifecycle rule) → `failed` (`decode_failed`, `warn`). An output over 16 383 px on a side (the WebP limit; e.g. 200 × 20 000) → `dimensions_out_of_range`. Private outputs carry `Cache-Control: private, no-store`. `MEDIA_PROCESSING_STUCK` is logged on every cleanup run while a row stays stuck (count + up to 20 ids) | UC-ME-3, UC-ME-4 |
| ME-13 | An invalid upload on `complete`: the row becomes `failed` first, then the object is deleted (a failed delete is `warn MEDIA_OBJECT_DELETE_FAILED`) | UC-ME-2 |

### 7.2 Clarifications (R2-P6 plan, approved 2026-10-21)

| # | Clarification | Where |
|---|---|---|
| ME-14 | `return_photo` may be uploaded by a customer (the request) or a seller (a dispute, spec 18 UC-RE-8, RE-14). Returns checks that each photo was uploaded by the caller | §1 |
