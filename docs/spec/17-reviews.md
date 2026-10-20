# Spec 17 — reviews

Status: **v1.0 DRAFT (2026-10-20).** Release 2. Inputs: `00-overview.md` v2.0 draft §10.4 (reviews, ratings), R-10, R-11, `14-media.md` (review images). Open questions in §7 (RV-1…RV-8) must be answered before approval. The wishlist (R-12) is in spec 04 §8, the rating projections in spec 05 §8 and spec 06 §9.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Verified product reviews: only a customer who received the product can review it.
- Published at once; an admin can hide a review afterwards (post-moderation, R-10).
- The seller of the product may reply once (R-10).
- Reviews keeps the rating aggregates of every product and every seller and publishes them. Catalog and sellers store copies for filters and sorting (spec 06 §9, spec 05 §8). The seller rating is derived from the seller's product reviews; there is no separate seller review (R-11).

Tables:
- `product_reviews` (soft delete, `deleted_at`)
- `review_images` (new against overview §10.2: one row per image, spec 14)
- `review_replies` (one per review, `uq_review_replies_review_id`)
- `review_rating_stats` (new against overview §10.2: one row per product and one per seller, §1.2)

Depends on:
- `ordering`: is this a delivered order item of this customer (new public method, spec 09 v2.0 §8)
- `catalog`: product summaries for the customer's and the seller's lists, product existence for the public list
- `customers`: reviewer display names (RV-6)
- `sellers`: profile from the user id, seller status for replies
- `media`: review images

Nobody calls reviews synchronously. Catalog and sellers receive the aggregates through an event (§5), so the module graph stays acyclic.

Enums:
- `ReviewStatus`: `published, hidden`
- `RatingSubjectType`: `product, seller`

Limits:
- **env:** `REVIEW_WINDOW_DAYS` (60, R-10: a review can be written until `delivered_at` + 60 days), `REVIEW_EDIT_WINDOW_DAYS` (30, R-10: counted from the review's `created_at`).
- **constants:** rating `1..5`; title `1..120`; body `1..2000`; max **4** images per review (RV-3, purpose `review_image`, public); reply body `1..1000`; hide reason `3..500`.

### 1.1 Eligibility (UC-RV-1)
- **One review per customer and product** (RV-1), whichever order or variant the customer received. `uq_product_reviews_customer_id_product_id` (partial, `WHERE deleted_at IS NULL`).
- The review names the delivered order item it is based on (`orderItemId`). The item must belong to the customer, its seller order must be `delivered`, at least one unit must be open (`quantity − cancelled_quantity > 0`), and `delivered_at` must be within `REVIEW_WINDOW_DAYS`.
- A later return of the item (spec 18) does not remove the review (RV-2).

### 1.2 Rating aggregates
`review_rating_stats`: (`subject_type`, `subject_id`) unique, `rating_count INT`, `rating_sum INT`, `count_1` … `count_5 INT`, `version BIGINT`, all `NOT NULL`, with `CHECK`s (`rating_count = count_1 + … + count_5`, `rating_sum` between `rating_count` and `5 × rating_count`).
- Only **published, non-deleted** reviews count.
- Every write that changes what counts (create, rating edit, hide, unhide, delete) updates the product row and the seller row in the same transaction with an atomic upsert: `INSERT … ON CONFLICT (subject_type, subject_id) DO UPDATE SET rating_count = rating_count + ?, rating_sum = rating_sum + ?, count_<n> = …, version = version + 1, updated_at = now() RETURNING …`. No read-then-write.
- Lock order: review row → product stats row → seller stats row. Every write uses the same order, so there are no deadlocks.
- `rating_avg = round(rating_sum / rating_count, 2)` (`ROUND_HALF_UP`), `null` when `rating_count = 0`. Computed with `decimal.js`, never stored here.
- The same transaction writes the outbox event `review.rating_changed` with both aggregates and their `version`s (§5). The projections apply an aggregate only if its `version` is newer than the one they hold, so out-of-order or duplicate events can't roll a rating back.

## 2. Public API (`index.ts`)
None. Only event contracts.

## 3. Use cases

### UC-RV-1 Write a review (customer)
1. `ordering.getReviewableItem(customerId, orderItemId)` (spec 09 v2.0 §8) → `{ orderItemId, productId, variantId, sellerId, deliveredAt }` or `null`. `null`, not delivered, or fully cancelled → `422 REVIEW_NOT_ALLOWED`.
2. `deliveredAt + REVIEW_WINDOW_DAYS < now` → `422 REVIEW_WINDOW_CLOSED`.
3. One transaction:
   - insert the review (`status = published`, the snapshot `product_id`, `seller_id`, `order_item_id`, `variant_id`)
   - `media.claim(imageMediaIds, { purpose: review_image, ownerUserId }, trx)`, then insert `review_images` (positions 0..n-1)
   - update both aggregates (§1.2)
   - outbox `review.created`, `review.rating_changed`
4. `23505` on `uq_product_reviews_customer_id_product_id` → `409 REVIEW_ALREADY_EXISTS`. There is no pre-check besides the constraint: a concurrent second review simply loses.

### UC-RV-2 Edit or delete own review (customer)
- Lock the review `FOR UPDATE`. Missing, deleted, or another customer's → `404 REVIEW_NOT_FOUND`.
- **Edit** (rating, title, body, images replaced as a whole): only within `REVIEW_EDIT_WINDOW_DAYS` of `created_at` → `422 REVIEW_EDIT_WINDOW_CLOSED`. Allowed while `hidden`; the review stays hidden. A changed rating of a published review moves the aggregates by the difference. Removed images are released (`media.release`), new ones claimed. `edited_at` is set.
- **Delete:** any time. Soft delete (`deleted_at`), images released, aggregates decremented if it was published. The seller's reply stays attached to the deleted review and is no longer shown. The customer may write a new review of the product afterwards while the window (§1.1) is still open (RV-4).
- Both: outbox `review.rating_changed` when an aggregate changed.

### UC-RV-3 Seller replies (seller)
- The seller must be `approved` (`sellers.getSellerByUserId(userId, { trx, lockShared: true })`, the catalog write guard, SE-4) → `403 SELLER_NOT_APPROVED`.
- Lock the review `FOR UPDATE`. It must be a non-deleted review of one of the seller's products (`product_reviews.seller_id`) → else `404 REVIEW_NOT_FOUND`. A `hidden` review can't be replied to → `409 REVIEW_HIDDEN`.
- Insert the reply. `23505` on `uq_review_replies_review_id` → `409 REVIEW_ALREADY_REPLIED`. Replies can't be edited or deleted by the seller (R-10 "once", RV-5).
- Outbox `review.replied`.

### UC-RV-4 Admin hides or unhides
- Lock the review `FOR UPDATE`.
- **Hide** a review: `published → hidden`, `hidden_reason`, `hidden_by_user_id`, `hidden_at`; aggregates decremented.
- **Unhide**: `hidden → published`, the hide columns cleared; aggregates incremented.
- **Hide a reply:** sets `review_replies.hidden_at` (+ reason, admin); the reply is no longer shown. Unhide clears it. No aggregate effect.
- Wrong current state → `409 REVIEW_INVALID_STATUS_TRANSITION`. Each action writes an audit row (spec 20) and, for reviews, `review.rating_changed`.

## 4. Endpoints

```ts
interface ReviewDto {
  id: string; productId: string; rating: number; title: string | null; body: string | null;
  images: ImageDto[];                                   // public (spec 14)
  reviewer: { displayName: string };                    // "Mona A." (RV-6), never the customer id
  variantOptions: { attribute: string; value: string }[];  // from the order item snapshot
  reply: { body: string; createdAt: string } | null;    // null when hidden
  createdAt: string; editedAt: string | null;
}
interface MyReviewDto extends ReviewDto {
  status: ReviewStatus;                                 // the author sees that it was hidden, not why
  product: { id: string; slug: string; name: string; primaryImage: ImageDto | null };
  canEdit: boolean;                                     // within REVIEW_EDIT_WINDOW_DAYS
}
interface RatingSummaryDto {
  ratingAvg: string | null;                             // "4.30"
  ratingCount: number;
  distribution: { 1: number; 2: number; 3: number; 4: number; 5: number };
}
interface SellerReviewDto extends ReviewDto { product: { id: string; name: string }; canReply: boolean }
interface AdminReviewDto extends Omit<ReviewDto, 'reply'> {
  status: ReviewStatus; customerId: string; sellerId: string; orderItemId: string;
  hiddenReason: string | null; hiddenAt: string | null;
  reply: { body: string; createdAt: string; hiddenAt: string | null; hiddenReason: string | null } | null;  // hidden replies too
}
```

Lists use cursor pagination on `createdAt, id` (`TIMESTAMPTZ(3)`, D-11).

### 4.1 Public   auth: public · rate: general
| Endpoint | Query | Success | Errors |
|---|---|---|---|
| `GET /products/:productId/reviews` | whitelist `rating` (int, `eq,in`, sort) · `hasImages` (bool, `eq`) · `createdAt` (sort only, default `-createdAt`) | `200 ReviewDto[]` + meta (published, non-deleted only) | `PRODUCT_NOT_FOUND` 404 (not publicly visible, catalog) |
| `GET /products/:productId/reviews/summary` | – | `200 RatingSummaryDto` | `PRODUCT_NOT_FOUND` 404 |

The summary is read from `review_rating_stats`, never aggregated per request.

### 4.2 Customer   auth: customer · rate: general
| Endpoint | idem | Body | Success | Errors |
|---|---|---|---|---|
| `POST /reviews` | – | `orderItemId uuid` · `rating int(1..5)` · `title opt nullable str(1..120)` · `body opt nullable str(1..2000)` · `imageMediaIds opt uuid[]` `@ArrayMaxSize(4)` `@ArrayUnique` | `201 MyReviewDto` | `REVIEW_NOT_ALLOWED` 422, `REVIEW_WINDOW_CLOSED` 422, `REVIEW_ALREADY_EXISTS` 409, `MEDIA_NOT_ATTACHABLE` 422 |
| `GET /me/reviews` | – | whitelist `createdAt` (sort, default `-createdAt`) | `200 MyReviewDto[]` + meta | – |
| `GET /me/reviews/:reviewId` | – | – | `200 MyReviewDto` | `REVIEW_NOT_FOUND` 404 |
| `PATCH /me/reviews/:reviewId` | – | same fields as create except `orderItemId`, all `opt`, at least one; `imageMediaIds` replaces the list | `200 MyReviewDto` | `REVIEW_NOT_FOUND`, `REVIEW_EDIT_WINDOW_CLOSED` 422, `MEDIA_NOT_ATTACHABLE` |
| `DELETE /me/reviews/:reviewId` | – | – | `204` | `REVIEW_NOT_FOUND` |
| `GET /me/reviewable-items` | – | cursor, limit | `200 { orderItemId, orderId, orderNumber, product: { id, name, primaryImage }, variantOptions, deliveredAt, reviewWindowEndsAt }[]` + meta | – |

`GET /me/reviewable-items` lists delivered items still inside the window whose product the customer hasn't reviewed (ordering supplies the delivered items, newest delivery first; reviews filters out reviewed products with one `product_id = ANY(?)` query). No `Idempotency-Key` on `POST /reviews`: the unique constraint already makes a retry harmless (`409`).

### 4.3 Seller   auth: seller · rate: general
| Endpoint | Body / query | Success | Errors |
|---|---|---|---|
| `GET /seller/reviews` | whitelist `productId` (uuid, `eq`) · `rating` (int, `eq,in`) · `replied` (bool, `eq`) · `createdAt` (date, `gte,lte`, sort, default `-createdAt`) | `200 SellerReviewDto[]` + meta (published, non-deleted reviews of the seller's products) | – |
| `POST /seller/reviews/:reviewId/reply` | `body str(1..1000)` | `201 SellerReviewDto` | `SELLER_NOT_APPROVED` 403, `REVIEW_NOT_FOUND` 404, `REVIEW_HIDDEN` 409, `REVIEW_ALREADY_REPLIED` 409 |

Sellers read reviews in any seller status; replying needs `approved`.

### 4.4 Admin   auth: admin · rate: general
| Endpoint | Body / query | Success | Errors |
|---|---|---|---|
| `GET /admin/reviews` | whitelist `status` (enum, `eq`) · `productId` · `sellerId` · `customerId` (uuid, `eq`) · `rating` (int, `eq,in,lte`) · `createdAt` (date, `gte,lte`, sort, default `-createdAt`) | `200 AdminReviewDto[]` + meta (deleted reviews left out) | – |
| `GET /admin/reviews/:reviewId` | – | `200 AdminReviewDto` | `REVIEW_NOT_FOUND` 404 |
| `POST /admin/reviews/:reviewId/hide` | `reason str(3..500)` | `200 AdminReviewDto` | `REVIEW_NOT_FOUND`, `REVIEW_INVALID_STATUS_TRANSITION` 409 |
| `POST /admin/reviews/:reviewId/unhide` | – | `200 AdminReviewDto` | same |
| `POST /admin/reviews/:reviewId/reply/hide` | `reason str(3..500)` | `200 AdminReviewDto` | `REVIEW_NOT_FOUND`, `REVIEW_REPLY_NOT_FOUND` 404, `REVIEW_INVALID_STATUS_TRANSITION` |
| `POST /admin/reviews/:reviewId/reply/unhide` | – | `200 AdminReviewDto` | same |

## 5. Events
Published:
- `review.created` `{ reviewId, productId, sellerId, customerId, rating }` → notifications (the seller, RV-8)
- `review.replied` `{ reviewId, productId, customerId }` → notifications (the reviewer, RV-8)
- `review.rating_changed` `{ product: { productId, ratingCount, ratingSum, version }, seller: { sellerId, ratingCount, ratingSum, version } }` → catalog (queue `catalog.listing-projections`), sellers (new queue `sellers.rating-projection`). The consumers compute `rating_avg` themselves with the §1.2 rule, so every copy rounds the same way.

Consumed: none.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `REVIEW_NOT_FOUND` | 404 | Missing, deleted, or not the caller's (customer) / not of the seller's products (seller) |
| `REVIEW_NOT_ALLOWED` | 422 | The order item isn't a delivered, open item of the customer |
| `REVIEW_WINDOW_CLOSED` | 422 | Delivered more than `REVIEW_WINDOW_DAYS` ago |
| `REVIEW_ALREADY_EXISTS` | 409 | The customer already has a live review of the product |
| `REVIEW_EDIT_WINDOW_CLOSED` | 422 | Edit after `REVIEW_EDIT_WINDOW_DAYS` |
| `REVIEW_HIDDEN` | 409 | Seller reply to a hidden review |
| `REVIEW_ALREADY_REPLIED` | 409 | A second reply |
| `REVIEW_REPLY_NOT_FOUND` | 404 | Hide / unhide a reply that doesn't exist |
| `REVIEW_INVALID_STATUS_TRANSITION` | 409 | Hide a hidden review, unhide a published one (same for replies) |

(`SELLER_NOT_APPROVED`, `MEDIA_NOT_ATTACHABLE`, `PRODUCT_NOT_FOUND` come from other modules.)

Config: api `REVIEW_WINDOW_DAYS`, `REVIEW_EDIT_WINDOW_DAYS`. No defaults. The worker needs none.

## 7. Open questions

| # | Topic | Options / recommendation |
|---|---|---|
| RV-1 | Reviews per customer and product (overview §10.4 said "once per delivered order item") | **Rec:** one live review per customer and product, based on any delivered item of it; buying the same product again doesn't add a second vote · or one per delivered order item (a repeat buyer counts several times) |
| RV-2 | Review after the item is returned (spec 18) | **Rec:** the review stays (the customer did receive the product; a review explaining a return is useful) · or hide it automatically when the item is returned |
| RV-3 | Images per review | **Rec:** up to 4, public, same upload limits as R-1 · or none in R2 |
| RV-4 | Deleting a review | **Rec:** the author may delete any time (soft delete, aggregates updated) and write a new one while the window is open · or reviews can't be deleted, only edited |
| RV-5 | Seller reply editing | **Rec:** one reply, final (R-10 "once"); an admin may hide it · or editable within N days |
| RV-6 | Reviewer name shown | **Rec:** first name + last initial ("Mona A."), from customers (new batched `getDisplayNames`) · or always anonymous ("Verified buyer") |
| RV-7 | User reports of abusive reviews | **Rec:** not in R2; admins find reviews through the admin list (filter by rating, product, seller) and hide them · or a "report" button with a report queue |
| RV-8 | Review notifications | **Rec:** in-app + push under the `orders` category: the seller on a new review ("New review on one of your products"), the reviewer on a seller reply ("The seller replied to your review"); no product names in the push text (R-7 style) · or no notifications for reviews |
