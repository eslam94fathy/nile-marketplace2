# Implementation Plan (Release 2)

Status: **v1.0 APPROVED (2026-10-20).** §2.2 R2-Q1…R2-Q7 answered (every recommendation accepted); R2-P0 is done (§2.1). R2 code was to start after P9 (CLAUDE.md §14.1l); on 2026-10-20 the user started R2-P1 before P9. Because `main` does not hold R1 yet (P8-Q1), `r2-p1-media` is stacked on `r2-specs` instead of branching from `main` (R2-Q3), and the staging parts of each phase wait for P9.
Inputs: `CLAUDE.md`, `docs/spec/00-overview.md` v2.0 §10 (answers §10.8–§10.12), specs 01–20 (Release 2 sections), `docs/design/01-architecture.md` v2.0 draft §14, `docs/design/02-database.md` v2.0 draft §14. Release 1 plan: `00-implementation-plan.md`.

---

## 1. Phase order

Each phase ends green in CI (lint, type-check, unit, integration, build, Docker build, Trivy, audit), is deployed to staging, and is one reviewable PR (or a short series). The overview §10.5 order is kept, except that the **audit module moves into R2-P1** (R2-Q2).

| Phase | Content | Specs (R2 sections) | Infra |
|---|---|---|---|
| **R2-P0** | Specs, design, this plan; fold the approved drafts into their specs (§2) | all | – |
| R2-P1 | **Audit** (module + every existing admin write) · **media** (uploads, processing, cleanup) · product and category images · order-item image snapshot | 14, 20 §2, 06 §8, 08 §8 (images), 09 §8.3 | S3 bucket, CloudFront, MinIO, IAM |
| R2-P2 | **Realtime** gateway · notification centre · Web Push · web token transport (cookie) · identity session events · ordering public API (recipients) · `seller_order.accepted` | 15, 13 §8, 03 §8, 09 §8.1–8.2, 04 / 05 §8 (lookups), 02 §6.1–6.3 | realtime ECS service, ALB rule, VAPID secret, worker Redis |
| R2-P3 | **Support** tickets | 16 | – |
| R2-P4 | **Reviews**, ratings, wishlist | 17, 04 §8, 05 §8, 06 §9 | – |
| R2-P5 | **Back-office**: dashboard, user directory, admin cancellation, product block | 20 §3, 09 §8.4 | – |
| R2-P6 | **Returns**, return shipments, automated refunds, COD customer refunds, **holding period** | 18, 07 §8, 09 §8.7, 10 §8, 11 §8, 12 §8 | worker gets the Kashier secret key |
| R2-P7 | **Coupons** | 19, 08 §8 (preview), 09 §8.8 | – |
| R2-P8 | **Hardening**: security review of uploads, sockets, cookies, push, refunds; socket and upload load test; R2 runbooks; staging sign-off | – | alarms for the new queues and jobs |

Dependencies between phases: P2 needs P1 only for `media.ready` pushes (P1 works with polling); P3 needs P1 (attachments) and P2 (socket, notifications); P4 needs P2 (notifications) and P1 (review images); P5 needs P1 (audit); P6 needs P1, P2 and P5 (audit, admin views); P7 needs nothing after P2, but goes last because it changes checkout and every money event (spec 09 §8.8, OR-22).

---

## 2. R2-P0 close-out

### 2.1 What is left in R2-P0
1. **Approval of the drafts as a whole** (R2-Q1). Every open question is answered (overview §10.9–§10.12), but the documents are still drafts.
2. **Approval (done 2026-10-20):** every document below was approved at the version shown. The Release 2 parts were **not** moved into §1–§7: they stay as their own numbered sections (§8, §9, §14, …), because other specs, the design and this plan cite them by number dozens of times (e.g. "spec 09 §8.7"), and moving them would break those references. Each status line now says so:

| Document | From | To |
|---|---|---|
| `00-overview.md` | v1.1 + §10 draft | v2.0 (§10 becomes [CONFIRMED]) |
| `01-api-conventions.md` | v1.3 + §9 draft | v1.4 |
| `02-events.md` | v1.1 + §6 draft | v1.2 |
| `03`, `04`, `05`, `06`, `09`, `13` | R1 version + §8 / §9 drafts | v2.0 each |
| `07`, `08`, `10`, `11`, `12` | R1 version + §8 drafts | v2.0 each |
| `14`…`20` | v1.0 draft | v1.0 approved |
| `01-architecture.md` | v1.10 + §14 draft | v2.0 |
| `02-database.md` | v1.13 + §14 draft | v2.0 |

3. CLAUDE.md: §1 stack table gains object storage (S3 / CloudFront, MinIO), Socket.IO and Web Push; §2.1 folder tree gains `realtime.ts`; §15 "Release 2" line points to the approved scope.

### 2.2 Decisions (answered 2026-10-20)

The user accepted every recommendation. The table is kept for the reasoning; the answers are logged in `00-overview.md` §10.13.

| # | Topic | Options / recommendation |
|---|---|---|
| R2-Q1 | Approving the R2 documents | **Rec:** approve every R2 draft as written with its answered questions, in one docs commit on `r2-specs` (§2.1) · or approve per document |
| R2-Q2 | When the audit module is built | **Rec:** in R2-P1, together with wiring every existing R1 admin write: from then on each new admin write ships audited, instead of retrofitting P1–P4 in P5 · or in R2-P5 as the overview phase list had it |
| R2-Q3 | Branches | **Rec:** `r2-specs` merges into `main` after R2-Q1 (docs only); then one branch per phase from `main` (`r2-p1-media`, `r2-p2-realtime`, …), each merged after green CI and a staging deploy · or one long-lived `release-2` branch |
| R2-Q4 | Event payload and enum changes during rolling deploys | **Rec:** before production go-live, a phase ships in one deploy (only staging runs it); after go-live, a change a running consumer can't parse (new enum value, OR-22 fields) is shipped in two deploys: consumers first, publisher second, and parse failures of known event types stay retries (not DLQ) during a deploy · or always two deploys |
| R2-Q5 | Production | **Rec:** R2 phases go to staging as they merge; production gets R1 and R2 at the separate go-live decision (P8-Q3), or R1 first if go-live comes before R2 ends · or R2 to production phase by phase after go-live |
| R2-Q6 | Things the user provides | **Rec:** before R2-P1: DNS for `media.<domain>` (CloudFront, certificate in `us-east-1`); before R2-P2: the web app origin(s) for `CORS_ALLOWED_ORIGINS` and the realtime URL agreed with the web team; before R2-P6: the Kashier test account used for the refund API (the P5 one) |
| R2-Q7 | VAPID keys | **Rec:** one key pair per environment, generated with `web-push generate-vapid-keys` on a trusted machine, the private key put into Secrets Manager by hand (like the JWT keys); rotation documented in the runbook (rotation drops every subscription) · or generated by Terraform (the private key would sit in state) |

### 2.3 Dependencies (A-9, approved 2026-10-20)
Exact versions are pinned at install (`save-exact=true`), using the latest stable release that is ≥ 2 weeks old **on the install day**. Candidates as of 2026-10-20 (checked with `npm view`; re-checked at install):

| Package | Candidate | Phase | Note |
|---|---|---|---|
| `@aws-sdk/client-s3`, `@aws-sdk/s3-presigned-post`, `@aws-sdk/s3-request-presigner` | 3.1147.0 | P1 | Same version for all three |
| `sharp` | 0.35.5 | P1 | Prebuilt `linux-x64` glibc binary; the runtime image is `node:24-*-slim` (glibc), so no build tools in the image. Trivy scans its bundled libvips |
| `socket.io` | 4.8.4 | P2 | |
| `@socket.io/redis-adapter` | 8.3.0 | P2 | Last release 2024-03; works with `ioredis` |
| `@socket.io/redis-emitter` | 5.1.0 | P2 | Last release 2023-01. Compatibility with socket.io 4.8 / redis-adapter 8.3 is the first task of P2 (RT-7); if it fails, the worker publishes through the adapter's own Redis protocol with a small in-house emitter (a new decision, not assumed) |
| `web-push` | 3.6.7 | P2 | Last release 2024-01; RFC 8291 / VAPID are stable standards |
| dev: `@types/web-push` | 3.6.4 | P2 | |
| dev: `socket.io-client` | 4.8.4 | P2 | Integration tests |
| dev: `@testcontainers/minio` | 12.1.0 | P1 | Matches the installed `testcontainers` 12.1.0 |

**Installed 2026-10-20 (R2-P1 step 2):** `@aws-sdk/*` **3.1146.0** (3.1147.0 was published 2026-10-06 22:58 UTC, under two weeks old on the install day), `sharp` 0.35.5, `@testcontainers/minio` 12.1.0. `sharp` loads in the runtime image with `npm ci --ignore-scripts` (prebuilt `@img/sharp-linux-x64`), and Trivy finds nothing HIGH / CRITICAL in it. MinIO image: `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (architecture v2.2 §14.9).

**Installed 2026-10-20 (R2-P2 step 1):** `socket.io` 4.8.4, `@socket.io/redis-adapter` 8.3.0, `@socket.io/redis-emitter` 5.1.0, dev `socket.io-client` 4.8.4 (every candidate ≥ 2 weeks old; `npm audit` clean). `web-push` and its types are installed with step 6.

**RT-7 compatibility check (2026-10-20, passed).** Two gateways on the classic `createAdapter` and a worker-style `Emitter`, all on the project's `ioredis` 6.0.0, against Redis 7.2, WebSocket transport only. Passed: an emit to a room reaches its sockets on both gateways and no others; a multi-room emit reaches a socket in two of the rooms once; JSON payloads round-trip (a `Date` arrives as an ISO string, UTF-8 intact); a gateway's room emit reaches the other gateway; `emitter.in(room).disconnectSockets(true)` closes exactly that room's sockets on both gateways (spec 15 `user.suspended`); `fetchSockets` sees remote sockets; after a dropped Redis connection, ioredis queues the publish and delivers it on reconnect. **One hazard found:** the emitter calls `redisClient.publish(…)` and drops the promise (5 call sites in 5.1.0, and `publish` is the only method it calls), so a publish on a closed connection is an **unhandled rejection**, which our `unhandledRejection` handler turns into a worker shutdown. `lib/realtime` therefore hands the emitter a client whose `publish` catches the rejection, logs a `warn` and drops the message, which is the RT-3 behaviour (drop on Redis down); verified in the same check. No in-house emitter is needed.

---

## 3. Rules for every R2 phase

- **Docs first:** a phase starts with its spec sections folded (R2-Q1). A behaviour change found while coding goes through its spec first, with a version bump (as in R1).
- **Migrations:** database v2.0 §14.2 (temporary default dropped in the same migration, `NOT VALID` + `VALIDATE`, concurrent indexes in their own migrations, expand / contract for enum removals). Every migration has a working `down`.
- **Module graph:** the architecture §14.2 table is added to `module-graph.js` edge by edge, in the phase that first needs the edge; CI keeps failing on a cycle.
- **Env:** new keys go into the zod schema of each process that reads them, `.env.example`, `infra/terraform/.../env-keys.json` and the task definitions in the same commit (the P8 `env-keys` test checks them). No defaults.
- **Audit:** from R2-P1 on, every new admin write calls `audit.record` in its transaction, with its action in `app/audit/actions.ts`.
- **Tests (CLAUDE.md §12):** every endpoint gets integration tests for its happy path, validation failure, authz failure and not-found; every consumer a duplicate-delivery test; every job a two-workers test; plus the concurrency tests named per phase.
- **OpenAPI:** every new endpoint documented; the socket contract in `docs/realtime.md` (RT-6).
- **Staging:** each phase is deployed to staging and smoke-tested there before its PR is called done.

---

## 4. R2-P1: audit · media · images

### 4.1 Delivers
Audited admin writes (all of R1's), image uploads end to end (presign → upload to S3 / MinIO → complete → worker processing → ready), product images (seller), category images (admin), images in public product views, cart and order history.

### 4.2 Scope
| Area | Content |
|---|---|
| Migrations | `admin_audit_log` + trigger · `media_objects` · `product_images`, `categories.image_*` · `order_items.image_media_id` + its concurrent index |
| `app/audit` | `record`, `actions.ts`, `GET /admin/audit-log`, `/:id`, retention job; wiring into identity, sellers, catalog, delivery, payments, finance admin writes and the `seed-admin` CLI |
| `pkg/storage` | `IObjectStorage` (presign POST / GET, head, range get, put, delete) + S3 adapter (MinIO via `endpoint` + path style) + in-memory fake (A-10) |
| `pkg/image` | `IImageProcessor` over `sharp` (decode limits, rotate, strip, resize, WebP) |
| `app/media` | spec 14: endpoints, `media.processing` consumer, cleanup job, `claim` / `release` / `getImages` |
| catalog / cart / ordering | spec 06 §8, cart line images, `order_items.image_media_id` snapshot, `OrderItemDto.image` |
| Config | spec 14 §6 keys, rate class `upload`, `JOB_AUDIT_RETENTION_INTERVAL_MS`, `AUDIT_RETENTION_DAYS`, `AUDIT_RETENTION_BATCH_SIZE` |
| Docker / tests | MinIO in docker-compose (+ bucket init) and Testcontainers |
| Terraform | modules `s3-media`, `cdn` (CloudFront + OAC + ACM `us-east-1`), task-role policies, new env keys; applied to staging |

### 4.3 Tests
Audit: a row per admin write with the right fields, nothing secret in `changes`, rollback leaves no row, `UPDATE` rejected by the trigger. Media: wrong type / oversize / missing object / magic-byte mismatch, decompression-bomb image, EXIF GPS stripped (asserted on the output), redelivered processing message, private URLs only to authorised viewers, cleanup of each candidate kind incl. an FK-retained object. Images: limit of 8 under two parallel adds, reorder validation, variant soft delete unties images, cache deleted after writes.

### 4.4 Order of work (one commit each)
1. Migrations for audit; `app/audit`; wiring of the R1 admin writes and the CLI.
2. `pkg/storage`, `pkg/image` + MinIO in compose and tests.
3. Media migration, `app/media` endpoints, consumer, cleanup job.
4. Catalog images (migration, endpoints, reads, cache).
5. Cart and ordering image snapshot.
6. Terraform (bucket, CDN, IAM, env keys); staging deploy and smoke test.

### 4.5 Done when
CI green; a seller uploads an image on staging through the presigned flow, it is processed, attached, and served from `media.<domain>`; every R1 admin write leaves an audit row.

---

## 5. R2-P2: realtime · notification centre · push · web tokens

### 5.1 Delivers
The web client can log in with the refresh cookie, open a socket, receive order / shipment / payment / media messages, see its notification centre and get browser push.

### 5.2 Scope
| Area | Content |
|---|---|
| First task | Verify `@socket.io/redis-emitter` 5.1 with `socket.io` 4.8 and `redis-adapter` 8.3 against Redis 7 (RT-7, §2.3) |
| identity | spec 03 §8: cookie transport, `X-Nile-Client`, CORS with credentials, `user.suspended`, `user.sessions_revoked` |
| ordering | public API `getNotificationParties`, `getCustomerOrderLink`, `getSellerOrderLink`, `getOrderNumbers`; `seller_order.accepted` |
| customers / sellers / delivery | `getUserIds` lookups |
| `src/realtime.ts`, `app/realtime` | gateway (spec 15), own env schema, health, shutdown; `messages.ts` + `docs/realtime.md` |
| `lib/realtime` | `IRealtimeEmitter` over the Redis emitter; worker Redis connection |
| notifications | spec 13 §8: tables, `notifications.user-events`, `notifications.push`, endpoints, retention job; `pkg/push` (`web-push`, endpoint allow-list) |
| Terraform | `realtime` ECS service, ALB rule, idle timeout 120 s, VAPID secret, worker `REDIS_URL` |

### 5.3 Tests
Cookie transport (set, rotate, clear, CSRF header required, body + cookie rejected), socket handshake (bad origin, bad / expired token, suspended user, disconnect at `exp`), rooms (a customer never receives another customer's message), fan-out through two gateway instances, signal rate limit, push (410 deletes the subscription, transient → retry, SSRF host rejected), notification dedupe per event and recipient.

### 5.4 Order of work
1. Emitter compatibility check (spike, result written into this plan).
2. Identity web transport + session events.
3. Ordering public API, `seller_order.accepted`, recipient lookups.
4. Realtime gateway + fan-out consumer + docs.
5. Notification centre + preferences.
6. Web Push.
7. Terraform + staging deploy. **Deferred to P9 (user, 2026-10-21):** written together with the staging deploy once the AWS accounts exist, not offline beforehand. Steps 1–6 are done on `r2-p2-realtime`. Needed then: the realtime ECS service, the ALB `/realtime*` rule and 120 s idle timeout, the worker's Redis access, the `VAPID_PRIVATE_KEY` secret, the web app origins for `CORS_ALLOWED_ORIGINS`, and the VAPID key pairs.

### 5.5 Done when
CI green; on staging a browser session logs in with the cookie, receives `order.updated` live and a push notification for a COD order's progress.

---

## 6. R2-P3: support

Branch `r2-p3-support`, stacked on `r2-p2-realtime` (2026-10-21). Inputs: spec 16 v1.1 (§7.1 SU-7…SU-16), spec 13 v2.3 (NO-31), spec 04 v2.1 §8.7, spec 05 v2.1 §8.3, database v2.5 (D-18).

### 6.1 Delivers
Customers and sellers open tickets about their account or orders, chat with the admins with private image attachments, and see live updates; admins work a queue (filters, oldest waiting, SLA flag), write internal notes, assign, resolve and close, every action audited.

### 6.2 Scope
| Area | Content |
|---|---|
| Migrations | `support_ticket_number_seq`, `support_tickets`, `support_messages`, `support_message_attachments`, `support_ticket_reads` with the D-18 CHECKs; the §14.7 indexes (new, empty tables: plain `CREATE INDEX` in the table migration) |
| customers / sellers | `getFullNamesByUserIds`, `getSummariesByUserIds` (SU-8) |
| `app/support` | spec 16: user and admin endpoints, rate class `support-message`, `Idempotency-Key` on open and message post, attachment claim + presigned reads, `canView`, `getStats`, audit actions `support_ticket.assigned` / `.resolved` / `.closed` |
| Jobs | `support-jobs` (auto-close, SLA flag), advisory-locked, one ticket per short trx with `SKIP LOCKED` |
| realtime | `ticket.subscribe` / `unsubscribe`, `support.typing`; fan-out of the four `support.*` events (`support.message_created`, `support.ticket_updated`); `docs/realtime.md` |
| notifications | `support_reply`, `support_user_message`, `support_resolved` with the NO-31 links |
| Module graph | `support → ordering, customers, sellers, identity, media, audit`; `realtime → support` (architecture §14.2) |
| Config | api: `SUPPORT_MAX_OPEN_TICKETS_PER_USER`, `RATE_LIMIT_SUPPORT_MESSAGE_POINTS`, `RATE_LIMIT_SUPPORT_MESSAGE_WINDOW_SECONDS`; worker: `SUPPORT_SLA_HOURS`, `SUPPORT_AUTO_CLOSE_AFTER_HOURS`, `JOB_SUPPORT_INTERVAL_MS`, `SUPPORT_JOBS_BATCH_SIZE`; `.env.example`, `env-keys.json`, task definitions in the same commit |

### 6.3 Tests
Opener-only access (another user → `404`), internal notes never reach users (REST and socket), the status machine incl. reopen and the D-18 CHECKs, auto-assign on the first admin reply with two admins replying at once (one assignee, one `support.ticket_assigned`), assigning the current assignee writes nothing, message to a closed ticket, soft open-ticket limit, `Idempotency-Key` replay of an open and a message, attachments private (presigned GET only, foreign or unready media `422`), unread per user, SLA flag cleared on a new wait, auto-close and SLA jobs (two workers), duplicate delivery on the realtime and notification consumers, `ticket.subscribe` refused for a foreign ticket.

### 6.4 Order of work (one commit each)
1. Spec and design bumps (spec 16 v1.1, 13 v2.3, 04 v2.1, 05 v2.1, database v2.5), this section.
2. Migrations, the module skeleton, public API (`canView`, `getStats`), the customers / sellers lookups, module-graph edges.
3. User endpoints: open, list, detail, messages, post, read.
4. Admin endpoints: list with filters, notes, auto-assign, assign / resolve / close, audit.
5. Worker jobs (auto-close, SLA flag).
6. Realtime rooms, signals and fan-out; notification rows; `docs/realtime.md`.
7. Staging smoke test: waits for P9, as R2-P2 step 7.

### 6.5 Done when
CI green; a customer and an admin chat on staging with live updates and attachments (after P9).

## 7. R2-P4: reviews · ratings · wishlist

Branch `r2-p4-reviews`, stacked on `r2-p3-support` (2026-10-21). Inputs: spec 17 v1.1 (§7.1 RV-9…RV-13), spec 09 v2.2 (OR-26), spec 13 v2.4 (NO-32), spec 04 §8, spec 05 §8, spec 06 §9, database v2.6 (D-19).

### 7.1 Delivers
Customers review products they received (rating, text, up to 4 images), edit or delete them, and keep a wishlist; sellers read and answer the reviews of their products; admins hide reviews and replies; products and sellers show ratings, and the public product list filters and sorts by rating.

### 7.2 Scope
| Area | Content |
|---|---|
| Migrations | `product_reviews` (+ `variant_options`), `review_images`, `review_replies`, `review_rating_stats` · rating columns on `products` and `sellers` (DB-Q7: temporary default dropped in the same migration) · `idx_products_rating_id` concurrently · `wishlist_items` · the four review audit actions |
| ordering | `getReviewableItem` (with attributes), `listDeliveredItems` (`excludeProductIds`, D-19 sort) |
| customers | `getDisplayNames` ("Mona A."), wishlist endpoints (spec 04 §8), edge `customers → catalog` |
| catalog | `getProductCards`, `isPubliclyVisible`, rating on product views, `rating` filter and sort, the `review.rating_changed` projection, product create passes the rating columns |
| sellers | `sellers.rating-projection`, rating in `getSummaries` and profiles, public `GET /sellers/:sellerId` |
| `app/reviews` | spec 17: customer, public, seller and admin endpoints, aggregates, events, audit |
| notifications | `review_received`, `review_replied` (NO-32) |
| Module graph | `reviews → ordering, catalog, customers, sellers, media`; `customers → catalog` |
| Config | api: `REVIEW_WINDOW_DAYS`, `REVIEW_EDIT_WINDOW_DAYS`, `WISHLIST_MAX_ITEMS`; `.env.example`, `env-keys.json`, task definitions in the same commit |

### 7.3 Tests
One review per customer and product under two parallel posts; window and edit window; aggregates after create / edit / hide / unhide / delete (exact sums and counts, both subjects); out-of-order and duplicate `review.rating_changed` never roll back (catalog and sellers); a seller replies once, only to its own products, only when approved; hidden reviews and replies leave every public response; reviewable items exclude reviewed products and pages stay full; wishlist limit under parallel adds; rating sort and filter on the public list; review notifications; every endpoint's happy path, validation, authz and not-found.

### 7.4 Order of work (one commit each)
1. Spec and design bumps (spec 17 v1.1, 09 v2.2, 13 v2.4, database v2.6), this section.
2. Migrations and the module-graph edges.
3. Lookups: ordering, customers display names, catalog product cards and visibility.
4. Customer review endpoints with the aggregates and events.
5. Public, seller and admin review endpoints with the audit rows.
6. Rating projections in catalog and sellers, rating reads, the public seller page.
7. Wishlist.
8. Review notifications; Postman collection.
9. Staging check: waits for P9.

### 7.5 Done when
CI green; ratings visible and sortable on staging (after P9).

## 8. R2-P5: back-office

Scope: spec 20 §3 (`backoffice` module, dashboard, user directory with the new search indexes), spec 09 §8.4 (admin cancellation), product block (DB-Q8), notifications for blocks and admin cancels.
Tests: dashboard numbers against a seeded dataset (Cairo day boundaries around midnight UTC+2/+3), admin cancel all-or-nothing, a Kashier admin cancel flags a refund, blocked product can't be bought or re-activated, every action audited.
Done when: CI green; the dashboard renders on staging within the p95 read target with the perf seed.

## 9. R2-P6: returns · refunds · holding period

Scope: spec 18, inventory restock, ordering §8.7, payments §8 (automated refunds for every flag, COD refunds, status expand migration, worker secret), delivery §8 (return shipments), finance §8 (holds, new accounts, bookings, release job).
First task: verify Kashier's refund API on the test environment (request, response, idempotency by reference, listing a transaction's refunds) and write the result into spec 10 §8 before coding UC-PA-6 (as K-1…K-7 were in R1).
Tests: the whole return lifecycle incl. auto-approve, escalation, dispute, pickup failure; one open return under two parallel requests; amounts exact over several partial returns (with and without coupon data once P7 lands); refund job success / transient / permanent / unknown outcome (no blind resend); ledger balances for the spec 12 §8.4 example; hold released only without an open return; payout blocked while `seller_payable` is negative.
Done when: CI green; on staging a Kashier test order is returned and refunded automatically, and a COD return reaches the admin refund queue with decrypted payout details.

## 10. R2-P7: coupons

Scope: spec 19, cart preview, ordering §8.8 (checkout, columns, paid-amount events), payments / delivery / finance consumers on the paid-amount fields (R2-Q4 deploy order), close-step release.
Tests: allocation sums exactly (property-style test over random carts), global limit with N parallel checkouts (exactly the limit succeed), per-customer limit, release only on a fully cancelled checkout, commission per funding (R-17), ledger balances with platform and seller coupons, R1 events without a coupon unchanged (snapshot test of payloads).
Done when: CI green; on staging a checkout with a platform coupon and one with a seller coupon are delivered and booked correctly.

## 11. R2-P8: hardening

Scope: security review (`docs/security/r2-review.md`): uploads (presign conditions, magic bytes, image bombs, private URL leakage), sockets (origin, auth, room isolation, flooding), cookies / CSRF, push SSRF, payout data encryption, refund paths, audit completeness; findings fixed with regression tests. Socket and upload load test on staging (k6 WebSocket + upload scenarios) against architecture §14.8; R2 runbooks (VAPID rotation, media bucket, realtime scaling, refund queue handling); alarms for the new queues and log events.
Done when: no open high or critical finding; the load results are written up; staging signed off for the go-live decision.
