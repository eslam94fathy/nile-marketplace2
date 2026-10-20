# Spec 19 — promotions (coupons)

Status: **v1.0 DRAFT (2026-10-20).** Release 2. Inputs: `00-overview.md` v2.0 draft §10.4 (coupons), R-17, R-18, spec 09 v2.0 §8.8 (checkout and snapshots), spec 12 v2.0 §8 (funding in the ledger). Open questions in §7 (PR-1…PR-9) must be answered before approval.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Coupon codes the customer types at checkout. One coupon per checkout, applied to the items only, never to the delivery fee (overview §10.4).
- **Platform-funded** coupons are created by admins. Commission is taken on the undiscounted subtotal and the platform absorbs the discount (R-17).
- **Seller-funded** coupons are created by an approved seller for their own products. Commission is taken on the discounted subtotal (R-17).

Tables: `coupons`, `coupon_redemptions`.
Depends on: `sellers` (seller guard), `catalog` (category subtree for the scope check). Called by `ordering` (checkout, release) and `cart` (preview). Promotions calls neither, so the graph stays acyclic.

Enums:
- `CouponFunding`: `platform, seller`
- `DiscountType`: `percent, fixed`
- `CouponScope`: `all, seller, category`. A seller-funded coupon is always limited to its seller's products, optionally narrowed to a category.
- `CouponStatus`: `active, inactive` (stored). `scheduled` / `expired` are derived from the dates for display only.
- `RedemptionStatus`: `active, released`

### 1.1 Coupon fields
| Field | Rules |
|---|---|
| `code` | `^[A-Z0-9-]{4,32}$`, stored upper-case; unique across all coupons (`uq_coupons_code`) |
| `funding`, `seller_id` | `seller_id` set ⇔ `funding = seller` (CHECK) |
| `discount_type`, `discount_value` | percent: `rate` 0.01..0.90 · fixed: `money` > 0 |
| `max_discount` | `money` nullable; percent only |
| `min_items_subtotal` | `money` ≥ 0, compared with the **eligible** subtotal |
| `scope`, `scope_seller_id`, `scope_category_id` | `seller` → `scope_seller_id`; `category` → `scope_category_id` (its whole subtree); seller-funded → `scope ∈ (seller, category)` with `scope_seller_id = seller_id` (CHECKs) |
| `starts_at`, `ends_at` | `starts_at < ends_at`; `TIMESTAMPTZ` |
| `global_limit` | int ≥ 1, nullable (= unlimited) |
| `per_customer_limit` | int ≥ 1 (PR-3: required, the form proposes 1) |
| `redemption_count` | int ≥ 0, `<= global_limit` (CHECK); counts **active** redemptions |
| `status` | `CouponStatus` |

### 1.2 Discount computation (pure function in `promotions`, used by preview and checkout)
1. **Eligible lines:** cart lines whose product matches the scope (seller; category subtree via `catalog.getCategorySubtreeIds`, cached tree).
2. `eligibleSubtotal = Σ line_total` of eligible lines. `< min_items_subtotal` → `COUPON_MIN_SUBTOTAL_NOT_MET` (details: the missing amount).
3. Discount: percent → `round(eligibleSubtotal × rate, 2)` (`ROUND_HALF_UP`), capped at `max_discount`; fixed → `min(value, eligibleSubtotal)`.
4. **Allocation** to eligible lines in proportion to their `line_total`, each share rounded down to the piastre, then the leftover piastres go one by one to the lines with the largest remainders (ties: the earlier line in cart order). The shares always add up to the discount exactly, and every line keeps `discount ≤ line_total`.
5. Per seller order: `discount_amount = Σ its lines' shares`, with the coupon's `funding`.

## 2. Public API (`index.ts`)

| Method | Caller | Notes |
|---|---|---|
| `quote(code, customerId, lines: { variantId, productId, sellerId, categoryId, lineTotal }[]) → CouponQuote` | cart (preview), ordering (checkout, before its transaction) | Reads only. Validates §3.1 and computes §1.2. `CouponQuote = { couponId, code, funding, sellerId, discountTotal, lines: { variantId, discount }[] }` |
| `redeem({ couponId, customerId, orderId, discountTotal }, trx)` | ordering (checkout, the **last** step before `cart.clear`) | UC-PR-2 |
| `release(orderId, trx)` | ordering (close step) | UC-PR-3 |

## 3. Use cases

### 3.1 Validity checks (in this order)
1. Code unknown → `422 COUPON_NOT_FOUND`. `inactive` → `COUPON_INACTIVE`. Outside `[starts_at, ends_at)` → `COUPON_NOT_ACTIVE_YET` / `COUPON_EXPIRED`.
2. Seller-funded: the seller must be `approved` → else `COUPON_INACTIVE` (the customer gets no detail about the seller).
3. `global_limit` reached (soft read) → `COUPON_LIMIT_REACHED`. The customer's active redemptions `>= per_customer_limit` → `COUPON_CUSTOMER_LIMIT_REACHED`.
4. No eligible line → `COUPON_NOT_APPLICABLE`. Minimum not met → `COUPON_MIN_SUBTOTAL_NOT_MET`.
All are `422` with the common shape; the code tells the client which message to show.

### UC-PR-1 Preview (cart)
`POST /cart/coupon-preview` (spec 08 v2.0) → `quote` against the current cart lines (the cart's own issue rules apply: issue lines are left out, as in its totals). Nothing is stored; the cart holds no coupon (PR-1). The client sends the code again at checkout.

### UC-PR-2 Redeem (inside the checkout transaction)
Called after `payments.createForOrder`, so the coupon row is the **last** lock of the checkout (lock order, spec 09 §1.2 extended: `… → payments → coupons`). This keeps the hot row of a popular coupon locked for the shortest time and matches the release path.
1. `UPDATE coupons SET redemption_count = redemption_count + 1, updated_at = now() WHERE id = ? AND status = 'active' AND now() >= starts_at AND now() < ends_at AND (global_limit IS NULL OR redemption_count < global_limit) RETURNING id`. 0 rows → re-read to answer `COUPON_LIMIT_REACHED`, `COUPON_EXPIRED` or `COUPON_INACTIVE`; the checkout rolls back.
2. Per-customer limit: count the customer's `active` redemptions of the coupon. A customer's checkouts are already serialised by the cart lock (spec 09 §3.1 step 3), so this count can't race. Over → `COUPON_CUSTOMER_LIMIT_REACHED`.
3. Insert `coupon_redemptions` (`coupon_id`, `customer_id`, `order_id` unique, `discount_total`, `status = active`).

### UC-PR-3 Release (R-18)
Ordering's close step (spec 09 §3.9) calls `release(orderId, trx)` **only** when the order closes as `cancelled` (nothing delivered: cancelled before any delivery, or expired / failed unpaid). One transaction, still the last lock: redemption `active → released`, `released_at`, then `UPDATE coupons SET redemption_count = redemption_count − 1`. No redemption, or already released → no-op. Partial cancellations, `partially_completed` orders and returns keep the redemption (R-18); the discount shares stay pro rata on what remains (spec 09 §8.8).

### UC-PR-4 Manage coupons
- **Admin** creates platform-funded coupons (any scope) and may deactivate any coupon, seller-funded ones included (abuse).
- **Seller** (approved, catalog write guard SE-4) creates seller-funded coupons for their own products; a `category` scope still only covers the seller's products.
- **After the first redemption** only `ends_at` (later or earlier, not in the past), `global_limit` (not below `redemption_count`) and `status` can change → other fields `409 COUPON_LOCKED`. Before it, every field except `code` and `funding`.
- Coupons are never deleted (orders reference them); deactivate instead.
- Code taken → `409 COUPON_CODE_TAKEN` (`uq_coupons_code`, case-insensitive by storing upper-case).
- Admin writes are audited (spec 20); seller writes are not (R-19 covers admin writes).

## 4. Endpoints

```ts
interface CouponDto {
  id: string; code: string; funding: CouponFunding; sellerId: string | null;
  discountType: DiscountType; discountValue: string; maxDiscount: string | null; minItemsSubtotal: string;
  scope: CouponScope; scopeSellerId: string | null; scopeCategoryId: string | null;
  startsAt: string; endsAt: string; globalLimit: number | null; perCustomerLimit: number;
  redemptionCount: number; status: CouponStatus; displayStatus: 'scheduled' | 'active' | 'expired' | 'inactive';
  createdAt: string; updatedAt: string;
}
interface CouponQuoteDto {
  code: string; discountTotal: string;
  sellerOrders: { sellerId: string; discount: string }[];
  lines: { variantId: string; discount: string }[];
  itemsTotalAfterDiscount: string;
}
```

Create body (`CreateCouponDto`): `code str(4..32)` (pattern §1.1) · `discountType enum` · `discountValue` (`rate` for percent, `money` for fixed) · `maxDiscount opt nullable money` (percent only) · `minItemsSubtotal money` · `scope enum` · `scopeSellerId opt uuid` (admin, `seller` scope) · `scopeCategoryId opt uuid` (`category` scope) · `startsAt`, `endsAt` ISO date-time · `globalLimit opt nullable int(1..1000000)` · `perCustomerLimit int(1..100)`. Cross-field rules in the service → `422 COUPON_INVALID` with details.

### 4.1 Customer   auth: customer
Served by cart (spec 08 §8), which passes its lines to `quote`.
| Endpoint | rate | Body | Success | Errors |
|---|---|---|---|---|
| `POST /cart/coupon-preview` | `coupon-preview` (new class, user id, PR-6) | `code str(4..32)` | `200 CouponQuoteDto` | §3.1 codes, `CART_EMPTY` 422 |

Checkout gains `couponCode opt str(4..32)` (spec 09 §8.8).

### 4.2 Seller   auth: seller · rate: general
| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `GET /seller/coupons` | whitelist `status` (`eq`) · `createdAt` (sort, default `-createdAt`) | `200 CouponDto[]` + meta | – |
| `POST /seller/coupons` | `CreateCouponDto` (`scope ∈ seller, category`; `scopeSellerId` not accepted) | `201 CouponDto` | `SELLER_NOT_APPROVED` 403, `COUPON_INVALID` 422, `COUPON_CODE_TAKEN` 409, `CATEGORY_NOT_FOUND` 422 |
| `GET /seller/coupons/:couponId` | – | `200 CouponDto` | `COUPON_NOT_FOUND` 404 |
| `PATCH /seller/coupons/:couponId` | create fields, all `opt`, at least one, `code` excluded | `200 CouponDto` | `COUPON_NOT_FOUND`, `COUPON_LOCKED` 409, `COUPON_INVALID` 422, `SELLER_NOT_APPROVED` |

### 4.3 Admin   auth: admin · rate: general
| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/coupons` | whitelist `funding` · `status` (`eq`) · `sellerId` (uuid, `eq`) · `code` (text, `eq`) · `createdAt` (sort, default `-createdAt`) | `200 CouponDto[]` + meta | – |
| `POST /admin/coupons` | `CreateCouponDto` (platform-funded) | `201 CouponDto` | `COUPON_INVALID`, `COUPON_CODE_TAKEN`, `CATEGORY_NOT_FOUND`, `SELLER_NOT_FOUND` 422 |
| `GET /admin/coupons/:couponId` | – | `200 CouponDto` + the last 50 redemptions `{ orderId, customerId, discountTotal, status, createdAt }` | `COUPON_NOT_FOUND` |
| `PATCH /admin/coupons/:couponId` | as seller (platform coupons); for a seller coupon only `status` | `200 CouponDto` | `COUPON_NOT_FOUND`, `COUPON_LOCKED`, `COUPON_INVALID` |

## 5. Events
Published: none (redemptions are inside the checkout; the money effects travel in ordering's events, spec 09 §8.8).
Consumed: none.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `COUPON_NOT_FOUND` | 422 / 404 | Unknown code at preview / checkout (422); missing coupon id in management (404) |
| `COUPON_INACTIVE` | 422 | Deactivated, or the funding seller isn't approved |
| `COUPON_NOT_ACTIVE_YET` | 422 | Before `starts_at` |
| `COUPON_EXPIRED` | 422 | At or after `ends_at` |
| `COUPON_LIMIT_REACHED` | 422 | Global limit used up |
| `COUPON_CUSTOMER_LIMIT_REACHED` | 422 | The customer used it `per_customer_limit` times |
| `COUPON_NOT_APPLICABLE` | 422 | No cart line matches the scope |
| `COUPON_MIN_SUBTOTAL_NOT_MET` | 422 | Eligible subtotal below the minimum |
| `COUPON_INVALID` | 422 | Create / update cross-field rules (details) |
| `COUPON_CODE_TAKEN` | 409 | `uq_coupons_code` |
| `COUPON_LOCKED` | 409 | Changing a locked field after the first redemption |

New rate-limit class `coupon-preview`: user id, `RATE_LIMIT_COUPON_PREVIEW_POINTS` / `_DURATION_SECONDS` (proposed 20 per minute), so codes can't be guessed by brute force (PR-6). Checkout keeps its `checkout` limit.

## 7. Open questions

| # | Topic | Options / recommendation |
|---|---|---|
| PR-1 | Where the code lives before checkout | **Rec:** nowhere: preview endpoint for the cart page, code sent again with `POST /checkout` (no cart state, nothing to expire) · or the cart stores the applied code |
| PR-2 | Discount allocation | **Rec:** proportional to eligible line totals, largest-remainder rounding to the piastre, so shares add up exactly and refunds of single items are exact · or the whole discount on the most expensive line |
| PR-3 | Per-customer limit | **Rec:** required field, proposed 1 in the admin and seller forms · or optional (unlimited) |
| PR-4 | Targeting (first order only, specific customers) | **Rec:** not in R2 · or a "first order only" flag |
| PR-5 | Public coupon list | **Rec:** none in R2; codes are shared by marketing and sellers outside the app · or a public list of active platform coupons |
| PR-6 | Brute-force guard | **Rec:** rate class `coupon-preview` (20 / min per user) + the checkout limit; codes of at least 4 characters · or no extra limit |
| PR-7 | Seller coupons and commission (R-17) | **Rec:** commission on the discounted subtotal; the seller's net drops by the discount and the commission on it; shown in the seller order (`discountAmount`, `discountFunding`) · (R-17 already decided; this only confirms the display) |
| PR-8 | Changes after the first redemption | **Rec:** only `endsAt`, `globalLimit` (≥ redemptions) and `status`; everything else locked so orders keep matching their coupon · or editable at any time |
| PR-9 | Admin deactivating seller coupons | **Rec:** allowed (abuse), audited · or sellers only |
