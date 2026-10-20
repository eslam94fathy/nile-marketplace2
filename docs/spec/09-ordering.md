# Spec 09 — ordering

Status: **v1.5 APPROVED (2026-10-13).** v1.0: approved by the user with the Phase 5 clarifications in §7.1. v1.1: `amountCancelled` when the last units are cancelled (OR-12); what the order totals count (OR-13). v1.2: shipment events that overtake their predecessor are retried (OR-14). v1.3: the expiry job abandons nothing and waits on a payment in flight (OR-6 as amended by spec 10 PA-11, PA-13). v1.4: `seller_order.items_cancelled` carries `previousStatus` (OR-15). v1.5: one open Kashier payment per customer (OR-16, Phase 8 security review F-2). Changes from now on need explicit approval and a version bump.
**v2.1 APPROVED (2026-10-20):** §8.10 R2-P2 implementation clarifications OR-23…OR-25 (every recommendation accepted). **v2.0 APPROVED (2026-10-20):** §8 adds the Release 2 pieces other R2 specs rely on: a public API (ordering is now called by other modules), `seller_order.accepted`, the order-item image snapshot and admin cancellation (S-9 for R2). §8.7 (returns, spec 18) and §8.8 (coupons, spec 19) added 2026-10-20. Kept as its own section, so every cross-reference stays valid (R2-Q1). §8.6 OR-17…OR-19 answered 2026-10-20. §8.9 OR-20…OR-22 answered 2026-10-20.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Checkout (the orchestrator), the order and its per-seller split, snapshots, stored statuses, cancellations (whole and partial), the 24 h acceptance timeout, Kashier payment expiry, and the money of each seller order (subtotal, commission, net, agent fee share).
Tables: `orders`, `seller_orders`, `order_items`, `order_item_cancellations`, `order_status_history`, `seller_order_status_history`.
Depends on (sync): `customers`, `cart`, `catalog`, `sellers`, `inventory`, `payments`, `delivery` (fee + agent-share setting only). **No module calls ordering** (architecture §2).

Config: `SELLER_ACCEPT_TIMEOUT_HOURS` (24), `KASHIER_PAYMENT_TTL_MINUTES` (15), `JOB_SELLER_ACCEPTANCE_TIMEOUT_INTERVAL_MS` (60 000), `JOB_KASHIER_PAYMENT_EXPIRY_INTERVAL_MS` (30 000), `ORDER_JOBS_BATCH_SIZE` (100) (architecture §6; process split in OR-8).

### 1.1 Statuses
`SellerOrderStatus`: `pending_payment, placed, accepted, ready_for_pickup, picked_up, out_for_delivery, delivery_failed, returning_to_seller, returned_to_seller, delivered, cancelled`.
Terminal: `delivered`, `cancelled`, `returned_to_seller`.

| From | To | Trigger | Actor |
|---|---|---|---|
| `pending_payment` | `placed` | `payment.paid` | system |
| `pending_payment` | `cancelled` | payment expired / `payment.failed` | system |
| `placed` | `accepted` | seller accepts | seller |
| `accepted` | `ready_for_pickup` | seller marks ready | seller |
| `placed` | `cancelled` | customer, seller, or 24 h timeout | customer / seller / system |
| `accepted`, `ready_for_pickup` | `cancelled` | seller | seller |
| `ready_for_pickup` | `picked_up` | `shipment.picked_up` | delivery_agent |
| `picked_up`, `delivery_failed` | `out_for_delivery` | `shipment.out_for_delivery` | delivery_agent |
| `out_for_delivery` | `delivery_failed` / `returning_to_seller` | `shipment.attempt_failed` | delivery_agent |
| `out_for_delivery` | `delivered` | `shipment.delivered` | delivery_agent |
| `returning_to_seller` | `returned_to_seller` | seller confirms receipt | seller |

`OrderStatus` is **derived and stored** in the same transaction after every seller-order change:
1. Any seller order `pending_payment` → `pending_payment`.
2. All seller orders terminal → `completed` (all delivered) · `partially_completed` (≥1 delivered) · `cancelled` (none delivered). This is the **close** step (§3.9).
3. Every non-cancelled seller order is `placed` → `placed`.
4. Otherwise → `in_progress`.

### 1.2 Concurrency rule
Every write that touches a checkout locks **the `orders` row first** (`SELECT … FOR UPDATE`), then its seller orders, then calls inventory (which locks items sorted by id), then payments. The full order is `carts` (checkout only) → `orders` → `seller_orders` (by id) → `inventory_items` (by id) → `payments` (OR-3). One lock order everywhere → no deadlocks. It also serialises the status derivation and the agent-share remainder (§3.8) per checkout. Every seller-order transition is a conditional update on the expected status. 0 rows → `SELLER_ORDER_INVALID_STATUS_TRANSITION` (HTTP) or a guarded no-op with a `warn` log (consumers).

## 2. Public API (`index.ts`)
None. Only event contracts (in `lib/events/contracts`).

## 3. Use cases

### 3.1 UC-OR-1 Checkout (architecture §7.1)
Pre-transaction (reads):
1. `customers.getAddressSnapshot(customerId, addressId)`. `delivery.getGovernorateFees([governorateId])` → `null` fee → `GOVERNORATE_NOT_DELIVERABLE`.
2. `delivery.getAgentFeeShareRate()`.

One transaction:
3. `cart.getLinesForCheckout(customerId, trx)` (locks the cart). Empty → `CART_EMPTY`. Kashier only: the customer already has a `pending_payment` order → `ORDER_PAYMENT_PENDING` (details: that order's id) (OR-16).
4. `catalog.getVariantsForPurchase(ids, trx)`, `sellers.getCheckoutSnapshots(sellerIds, trx)`. Any variant not purchasable or seller not `approved` → `CART_HAS_ISSUES` (details: the variant ids).
5. Money (`Money`, overview §5): `line_total = price × qty`; per seller `subtotal`, `commission = round(subtotal × rate)`, `seller_net`; `items_total`; `delivery_fee`; `total`. `total ≠ expectedTotal` → `ORDER_TOTAL_CHANGED` (details: the current total) (S-8).
6. Insert `orders` (`order_number` from the sequence), `seller_orders` (pickup snapshot, commission snapshot), `order_items` (snapshots, `cancelled_quantity = 0`) as multi-row inserts, and the history rows.
   - COD: order + seller orders `placed`, `placed_at = now()`, `accept_deadline_at = now() + 24 h`.
   - Kashier: `pending_payment`, `payment_expires_at = now() + 15 min`, no deadline yet.
7. `inventory.reserve(lines with orderItemId, trx)` → `INSUFFICIENT_STOCK` rolls everything back.
8. `payments.createForOrder({ orderId, method, amount: total }, trx)`.
9. `cart.clear(customerId, trx)`.
10. COD: outbox `order.placed`.
11. Commit. Kashier: `payments.createKashierSession(orderId, paymentExpiresAt)` **after** commit; if it fails, `checkoutUrl = null` and the app calls §4.1.2 (SD-5). The idempotency layer stores and replays this `201` body as is, `checkoutUrl: null` included (OR-10).

### 3.2 UC-OR-2 Customer cancels a seller order
Only `placed` (Q-31). Whole seller order only. Effects: `cancelled` (`cancel_reason = customer_cancelled`, `cancelled_by_user_id`), `inventory.release` of all its open quantities, history (note in `reason`), outbox `seller_order.cancelled`, order re-derived (§1.1).

### 3.3 UC-OR-3 Seller accepts / marks ready
- Accept: `placed → accepted`, `accepted_at`. Allowed after the deadline only if the timeout job hasn't run yet (conditional update on `status = 'placed'` decides).
- Ready: `accepted → ready_for_pickup`, `ready_at`, outbox `seller_order.ready_for_pickup` (snapshot payload incl. `sellers.getSummaries` business name, the order's drop-off snapshot, COD amounts).

### 3.4 UC-OR-4 Seller cancels a seller order
From `placed`, `accepted`, `ready_for_pickup` (Q-31). Same effects as UC-OR-2 with `cancel_reason = seller_cancelled`. If a shipment already exists, delivery cancels it from `seller_order.cancelled` (or sends it back if the agent picked it up in the meantime, spec 11 §3.5).

### 3.5 UC-OR-5 Seller cancels item quantities (partial)
From `placed`, `accepted`, `ready_for_pickup`. Body: `quantity ≤ quantity − cancelled_quantity`.
1. `cancelled_quantity += q`, `line_total = unit_price × (quantity − cancelled_quantity)`, `order_item_cancellations` row.
2. `inventory.release([{ orderItemId, q }])`.
3. Recompute the seller order (`subtotal`, `commission = round(subtotal × rate)`, `seller_net`) and the order (`items_total`, `total`).
4. If **every** line of the seller order is now fully cancelled → the seller order becomes `cancelled` (`seller_cancelled`) and only `seller_order.cancelled` is emitted. Otherwise → `seller_order.items_cancelled`.
- The delivery fee is unchanged (Q-28). Kashier refunds and COD amount changes happen in payments (consumer).

### 3.6 UC-OR-6 Shipment progress (consumer `ordering.shipment-updates`)
Applies the transitions in §1.1. A seller order that's already `cancelled` ignores shipment events (`warn` log; the parcel return is handled by delivery).

### 3.7 UC-OR-7 Return received (seller)
`returning_to_seller → returned_to_seller`, `returned_at`, `inventory.release` of the open quantities (Q-33), outbox `seller_order.returned`, order re-derived.

### 3.8 UC-OR-8 Delivered (consumer of `shipment.delivered`)
One transaction (order row locked):
1. `out_for_delivery → delivered`, `delivered_at`.
2. `inventory.commit(orderItemIds)`.
3. **Agent fee share** (overview §5, Q-27, Q-37):
   - `n` = number of seller orders in the checkout (cancelled ones included).
   - `agentShareTotal = round(orders.delivery_fee × agent_fee_share_rate)` (snapshotted values).
   - `base = floor(agentShareTotal / n)` to the piastre, `remainder = agentShareTotal − base × n`.
   - This seller order gets `base`, plus `remainder` **if this delivery closes the order** (all others already terminal). If the last seller order to finish isn't delivered, the remainder stays with the platform (S-13).
4. Outbox `seller_order.delivered` (amounts, `agentId`, `agentFeeShare`, `codCollectedAmount`, `deliveryFeeCollected` from the shipment event).
5. Re-derive the order; close it if terminal (§3.9).

### 3.9 Close (order becomes terminal)
- `completed_at` or `cancelled_at`.
- Final `delivery_fee` = `0.00` if nothing was delivered (Q-28), else unchanged. `total = items_total + delivery_fee`.
- Outbox `order.closed` (`deliveredItemsTotal`, final and original fee).

### 3.10 Jobs (worker, advisory-locked)
Both jobs (OR-5): each run reads up to `ORDER_JOBS_BATCH_SIZE` candidate order ids from the partial index **without locks**, then handles **one order per short transaction**, starting with `SELECT … FROM orders WHERE id = ? FOR UPDATE SKIP LOCKED` (busy → left for the next run). A failing order is logged at `error` and doesn't stop the batch.
- **seller-acceptance-timeout:** orders with a `placed` seller order whose `accept_deadline_at < now()`. Per order: lock it, then each such seller order by a conditional update on `status = 'placed' AND accept_deadline_at < now()` → like UC-OR-4 with `seller_acceptance_timeout`, actor `system`.
- **kashier-payment-expiry:** orders `pending_payment` with `payment_expires_at < now()`, per order (OR-6):
  1. Local payment already `paid` (webhook applied, consumer not run yet) → skip without calling Kashier.
  2. Outside any transaction: `payments.fetchProviderStatus(orderId)` (asks Kashier, SD-5).
  3. Provider says paid → `payments.markPaidFromProvider(...)`, skip (the normal `payment.paid` flow places the order). Provider says `pending` (an attempt in flight) → skip; the next run asks again (spec 10 PA-13).
  4. Provider says unpaid or is unreachable → one transaction in the §1.2 lock order: lock the order and its seller orders → all seller orders `cancelled` (`payment_expired`), `inventory.release`, order closed as `cancelled` (fee 0), then `payments.expire(orderId, trx)` (conditional `initiated → expired`). `false` = the webhook won: roll back and skip. Outbox: `seller_order.cancelled` ×n, `order.closed` (and `payment.expired` from payments).
  5. A payment that still succeeds after expiry is handled by SD-5 (spec 10 UC-PA-2).

### 3.11 Payment results (consumer `ordering.payment-updates`)
- `payment.paid` (`lateAfterExpiry = false`): order `pending_payment → placed`, seller orders `→ placed` with `accept_deadline_at = now() + 24 h`, `placed_at`, outbox `order.placed`. Order not in `pending_payment` → no-op + `warn` (payments already flagged the refund, SD-5).
- `payment.failed`: like expiry step 3 with `cancel_reason = payment_failed`.

## 4. Endpoints

### 4.1 Customer   auth: customer

#### 4.1.1 `POST /checkout`   rate: checkout · idem: **required**
| field | rules |
|---|---|
| addressId | `uuid` |
| paymentMethod | `enum(PaymentMethod)` |
| expectedTotal | `money` (S-8) |

`201 CheckoutResultDto`:
```ts
interface CheckoutResultDto {
  order: OrderDetailDto;
  kashier: { checkoutUrl: string | null; expiresAt: string } | null;   // null for COD
}
```
Errors: `CART_EMPTY` 422, `CART_HAS_ISSUES` 409, `ADDRESS_NOT_FOUND` 422, `GOVERNORATE_NOT_DELIVERABLE` 422, `ORDER_TOTAL_CHANGED` 409, `ORDER_PAYMENT_PENDING` 409, `INSUFFICIENT_STOCK` 409, idempotency errors.

#### 4.1.2 `POST /orders/:orderId/payment/kashier-session`   rate: checkout
Creates (or returns the still-valid) Kashier session through `payments`; one session per payment (OR-7). `200 { checkoutUrl: string; expiresAt: string }`.
Errors: `ORDER_NOT_FOUND` 404, `ORDER_NOT_AWAITING_PAYMENT` 409, `PAYMENT_PROVIDER_UNAVAILABLE` 502.

#### 4.1.3 Read
```ts
interface OrderSummaryDto {
  id: string; orderNumber: string; status: OrderStatus; paymentMethod: PaymentMethod;
  total: string; itemCount: number; sellerOrderCount: number; createdAt: string;
}
interface OrderDetailDto {
  id: string; orderNumber: string; status: OrderStatus; paymentMethod: PaymentMethod;
  paymentStatus: string;                                   // payments.getSummaries
  itemsTotal: string; deliveryFee: string; total: string;
  shippingAddress: { recipientName: string; recipientPhone: string; governorateId: string; governorateName: string;
                     city: string; area: string; street: string; building: string;
                     floor: string | null; apartment: string | null; landmark: string | null };
  sellerOrders: {
    id: string; sellerId: string; businessName: string; status: SellerOrderStatus; subtotal: string;
    canCancel: boolean;                                    // status === 'placed' (never while the order is pending_payment)
    items: OrderItemDto[];
    timeline: { status: SellerOrderStatus; at: string }[]; // from the history
  }[];
  paymentExpiresAt: string | null; placedAt: string | null; completedAt: string | null; cancelledAt: string | null;
  createdAt: string;
}
interface OrderItemDto {
  id: string; productId: string; variantId: string; productName: string; sku: string;
  attributes: { attribute: string; value: string }[];
  unitPrice: string; quantity: number; cancelledQuantity: number; lineTotal: string;
}
```
- `GET /orders`: whitelist `status` (enum, `eq,in`), `createdAt` (date, `gte,lte`, sort: yes, default `-createdAt`). → `200 OrderSummaryDto[]` + meta.
- `GET /orders/:orderId` → `200 OrderDetailDto`. Errors: `ORDER_NOT_FOUND` 404.

#### 4.1.4 `POST /orders/:orderId/seller-orders/:sellerOrderId/cancel`   idem: **required**
Body: `note opt str(1..500)`. → `200 OrderDetailDto`.
Errors: `ORDER_NOT_FOUND` 404, `SELLER_ORDER_NOT_FOUND` 404, `SELLER_ORDER_NOT_CANCELLABLE` 409.

### 4.2 Seller   auth: seller (any seller status: open orders continue after suspension, Q-36)

```ts
interface SellerOrderDto {
  id: string; orderId: string; orderNumber: string; status: SellerOrderStatus;
  paymentMethod: PaymentMethod;
  subtotal: string; commissionRate: string; commission: string; sellerNet: string;
  items: OrderItemDto[];
  dropoffGovernorate: { id: string; name: string };   // no customer name/phone/address (S-11)
  acceptDeadlineAt: string | null;
  cancelReason: string | null;
  acceptedAt: string | null; readyAt: string | null; pickedUpAt: string | null;
  deliveredAt: string | null; returnedAt: string | null; cancelledAt: string | null;
  createdAt: string;
}
```
`pending_payment` seller orders are never shown to sellers.

| Endpoint | idem | Body | Success | Errors |
|---|---|---|---|---|
| `GET /seller/orders` | – | whitelist `status` (`eq,in`), `createdAt` (`gte,lte`, sort, default `-createdAt`) | `200 SellerOrderDto[]` + meta | – |
| `GET /seller/orders/:sellerOrderId` | – | – | `200 SellerOrderDto` | `SELLER_ORDER_NOT_FOUND` 404 |
| `POST /seller/orders/:sellerOrderId/accept` | – | – | `200` | `SELLER_ORDER_NOT_FOUND`, `SELLER_ORDER_INVALID_STATUS_TRANSITION` 409 |
| `POST /seller/orders/:sellerOrderId/ready` | – | – | `200` | same |
| `POST /seller/orders/:sellerOrderId/cancel` | required | `note opt str(1..500)` | `200` | same + `SELLER_ORDER_NOT_CANCELLABLE` 409 |
| `POST /seller/orders/:sellerOrderId/items/:itemId/cancel` | required | `quantity int(1..99)` · `reason enum(out_of_stock, seller_request, other)` · `note opt str(1..500)` (required when `reason = other`) | `200` | `SELLER_ORDER_NOT_FOUND`, `ORDER_ITEM_NOT_FOUND` 404, `SELLER_ORDER_NOT_CANCELLABLE` 409, `ITEM_CANCEL_QUANTITY_INVALID` 422 |
| `POST /seller/orders/:sellerOrderId/return-received` | required | – | `200` | `SELLER_ORDER_NOT_FOUND`, `SELLER_ORDER_INVALID_STATUS_TRANSITION` |

### 4.3 Admin   auth: admin
- `GET /admin/orders`: whitelist `status` (`eq,in`), `orderNumber` (text, `eq`), `customerId` (uuid, `eq`), `createdAt` (`gte,lte`, sort, default `-createdAt`). → `200 OrderSummaryDto[]` (+ `customerId`) + meta.
- `GET /admin/orders/:orderId` → `200 OrderDetailDto` + `customerId`, per seller order `commissionRate/commission/sellerNet/cancelReason`, and the full order + seller-order status histories (actor role, actor id, reason). Errors: `ORDER_NOT_FOUND`.
- Admin cancellation isn't in R1 (S-9).

## 5. Events
Published: `order.placed`, `seller_order.ready_for_pickup`, `seller_order.items_cancelled`, `seller_order.cancelled`, `seller_order.returned`, `seller_order.delivered`, `order.closed`.
Consumed: `payment.paid`, `payment.failed` (`ordering.payment-updates`); `shipment.picked_up`, `shipment.out_for_delivery`, `shipment.attempt_failed`, `shipment.delivered` (`ordering.shipment-updates`).

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `CART_EMPTY` | 422 | Checkout with an empty cart |
| `CART_HAS_ISSUES` | 409 | A line is unavailable / seller not approved (details per variant) |
| `GOVERNORATE_NOT_DELIVERABLE` | 422 | The address governorate has no fee (Q-26) |
| `ORDER_TOTAL_CHANGED` | 409 | `expectedTotal` ≠ the computed total |
| `ORDER_PAYMENT_PENDING` | 409 | Kashier checkout while the customer has a `pending_payment` order (OR-16) |
| `ORDER_NOT_FOUND` | 404 | Missing or another customer's |
| `ORDER_NOT_AWAITING_PAYMENT` | 409 | Kashier session for an order that isn't `pending_payment`, or isn't Kashier |
| `SELLER_ORDER_NOT_FOUND` | 404 | Missing, another seller's, or not part of that order |
| `SELLER_ORDER_INVALID_STATUS_TRANSITION` | 409 | |
| `SELLER_ORDER_NOT_CANCELLABLE` | 409 | Customer: not `placed`. Seller: `picked_up` or later |
| `ORDER_ITEM_NOT_FOUND` | 404 | |
| `ITEM_CANCEL_QUANTITY_INVALID` | 422 | More than the open quantity |

(`ADDRESS_NOT_FOUND`, `INSUFFICIENT_STOCK`, `PAYMENT_PROVIDER_UNAVAILABLE` come from other modules. On checkout, `ADDRESS_NOT_FOUND` is returned as `422`, since the address is a body reference.)

## 7. Decisions (answered 2026-10-08, `00-overview.md` §9.1). No open questions.
- **S-8** `expectedTotal` is required at checkout.
- **S-9** No admin cancellation in R1.
- **S-11** Sellers see no customer PII.
- **S-13** The remainder goes to the delivery that closes the order, else stays with the platform.

### 7.1 Clarifications (v1.0, Phase 5 plan, 2026-10-12)

| # | Clarification | Where |
|---|---|---|
| OR-1 | Architecture §7.1 follows the §3.1 step order: the order rows are inserted **before** `inventory.reserve`, because a reservation references `order_item_id`; a shortfall still rolls everything back (A-3, architecture v1.7) | §3.1 |
| OR-2 | The shipment-driven use cases (UC-OR-6/7/8, the close step after delivery) are built in Phase 5 and tested by publishing the `shipment.*` contract events; delivery emits them from Phase 6 (P5-Q2) | §3.6–§3.9 |
| OR-3 | Lock order everywhere: `carts` (checkout only) → `orders` → `seller_orders` (by id) → `inventory_items` (by id) → `payments`. The payments webhook never locks `orders`, and the `ordering.payment-updates` consumer never locks `payments` (P5-Q3) | §1.2, §3.10 |
| OR-4 | The schema additions this spec relies on are database D-8 (v1.8): `idx_orders_created_at_id` for the unfiltered admin list, every FK `ON DELETE RESTRICT`, `order_number_seq` created with `orders` (P5-Q4) | §4.3 |
| OR-5 | Jobs read candidate ids without locks and handle one order per short transaction, `FOR UPDATE SKIP LOCKED` on the order row; batch size `ORDER_JOBS_BATCH_SIZE` (P5-Q5) | §3.10 |
| OR-6 | Expiry: a locally `paid` payment is skipped without a provider call; sessions are created with `expireAt = payment_expires_at`, so Kashier stops taking payment when the window closes. v1.3: nothing is abandoned (Kashier allows one open session per payment, spec 10 PA-11, PA-12), and a payment in flight (`pending`) is left for the next run (PA-13) (P5-Q6, K-1, K-3) | §3.10 |
| OR-7 | One Kashier session per payment: `kashier-session` returns the stored session while it is valid; a race is resolved in payments (spec 10 PA-3). No new session after `payment_expires_at` → `ORDER_NOT_AWAITING_PAYMENT` (P5-Q7) | §4.1.2 |
| OR-8 | Env split (P1-Q1): api `KASHIER_PAYMENT_TTL_MINUTES`, `SELLER_ACCEPT_TIMEOUT_HOURS`; worker `SELLER_ACCEPT_TIMEOUT_HOURS` (the payment consumer sets the deadline), both job intervals, `ORDER_JOBS_BATCH_SIZE`. No defaults (P5-Q10) | §1 |
| OR-9 | Read models: business names come live from `sellers.getSummaries`; `OrderSummaryDto.itemCount` = Σ open quantities (`quantity − cancelled_quantity`); detail views load seller orders, items and histories with one batched query each; `canCancel` is `false` while the order is `pending_payment` (P5-Q13) | §4 |
| OR-10 | The checkout `201` body is stored and replayed by the idempotency layer as is; a replay may show `checkoutUrl: null`, and the app then calls §4.1.2. The `checkout` rate limit (per user, fail closed) covers `POST /checkout` and §4.1.2 (P5-Q12) | §3.1, §4.1 |
| OR-11 | `KASHIER_REDIRECT_URL` is an https app link agreed with the mobile team before staging; the app never trusts the redirect and reads `GET /orders/:id` (P5-Q14) | §4.1.2 |
| OR-12 | When an item cancellation leaves no open unit, the seller order becomes `cancelled` and only `seller_order.cancelled` is published; its `amountCancelled` is the seller order's subtotal **before** that item cancellation, so the refund (Kashier) or COD reduction covers the last units too (Phase 5 step 4, v1.1) | §3.5 |
| OR-13 | A cancelled or returned seller order keeps its own `subtotal` (the record of what was cancelled). The order's `items_total` sums only the seller orders that are neither `cancelled` nor `returned_to_seller`, recomputed under the order lock after every change, and `total = items_total + delivery_fee`, so the order total is always what the customer still owes (it matches the COD payment amount). The close step then zeroes the fee if nothing was delivered (Phase 5 step 6, v1.1) | §1.1, §3.2–§3.9 |
| OR-14 | The `ordering.shipment-updates` consumer tells a **stale** event from an **early** one. Each shipment event has the statuses it applies from and the statuses that mean an earlier event of the same shipment isn't applied yet (`picked_up` early while placed / accepted; `out_for_delivery` while ready_for_pickup / out_for_delivery; `attempt_failed` and `delivered` while ready_for_pickup / picked_up / delivery_failed). An early event throws and is retried by the broker with backoff (DLQ + `error` log if it never applies); a stale one (seller order cancelled, or already past it) is a no-op with a `warn` log `SHIPMENT_EVENT_IGNORED` (Phase 5 step 7, v1.2) | §3.6, architecture §3.2 |
| OR-15 | `seller_order.items_cancelled` carries `previousStatus`: the seller order's status when the items were cancelled (unchanged by it), so delivery can tell a cancellation made while `ready_for_pickup` (shipment exists or is coming) from an earlier one (spec 02 v1.1 E-8, spec 11 DE-15; Phase 6 step 6, v1.4) | UC-OR-4 |
| OR-16 | At most one open payment per customer: a Kashier checkout while the customer has an order in `pending_payment` answers `409 ORDER_PAYMENT_PENDING` with that order's id in `details[0].value`, until it is paid, expires or fails. Checked after the cart lock, which serialises a customer's checkouts. COD checkouts are not affected (they never wait for payment). Stops one customer holding stock with repeated unpaid Kashier checkouts (Phase 8 security review F-2, v1.5) | §3.1 |

---

## 8. Release 2: public API, acceptance event, image snapshot, admin cancel [v2.0, approved 2026-10-20]

### 8.1 Public API (`index.ts`)
R1 had none (§2). R2 modules read ordering, and ordering still calls none of them, so the graph stays acyclic: realtime, notifications, support, reviews and backoffice depend on ordering; ordering depends on none of them (architecture v2.0).

| Method | Caller | Notes |
|---|---|---|
| `getNotificationParties({ orderIds?, sellerOrderIds? }) → NotificationParty[]` | realtime, notifications (spec 02 §6.3) | `{ orderId, orderNumber, customerId, status, sellerOrders: { sellerOrderId, sellerId, status }[] }`. Batched, current state (re-read, never trust the payload) |
| `getCustomerOrderLink(customerId, orderId, sellerOrderId?) → { orderId, orderNumber, sellerOrderId } \| null` | support (spec 16 UC-SU-1) | `null` when missing, another customer's, or the seller order isn't part of the order |
| `getSellerOrderLink(sellerId, sellerOrderId) → { orderId, orderNumber, sellerOrderId } \| null` | support | `null` when missing or another seller's; `pending_payment` seller orders count as missing (§4.2) |
| `getOrderNumbers(orderIds) → Map<orderId, orderNumber>` | support (ticket lists) | Batched |
| `getReviewableItem(customerId, orderItemId) → ReviewableItem \| null` | reviews (spec 17 UC-RV-1) | `{ orderItemId, orderId, productId, variantId, sellerId, deliveredAt, openQuantity }`. `null` when not the customer's, or its seller order isn't `delivered` |
| `listDeliveredItems(customerId, { deliveredAfter, cursor, limit }) → page of ReviewableItem & { orderNumber, productName, attributes }` | reviews (`GET /me/reviewable-items`) | Items with `openQuantity > 0` of `delivered` seller orders, `delivered_at >= deliveredAfter`, newest delivery first (cursor `delivered_at, id`) |
| `getDashboardStats(range) → OrderingStats` | backoffice (spec 20 §3.2) | Read-only aggregates, defined in spec 20 |

All of them are reads without locks and accept no `trx`; none of the callers needs one.

### 8.2 `seller_order.accepted`
UC-OR-3 (accept) writes the outbox event `seller_order.accepted` (payload in spec 02 §6.2) in the same transaction. Nothing consumes it for money or stock; realtime and notifications use it.

### 8.3 Order-item image snapshot
- New column `order_items.image_media_id` (nullable FK → `media_objects`, `RESTRICT`; `null` = the variant had no image at checkout, the stated reason for a nullable column). Checkout copies `catalog.getVariantsForPurchase(…).imageMediaId` (spec 06 §8.3).
- The snapshot does not `claim` the media: catalog owns the claim. When the seller later removes the image, catalog releases it, and the media cleanup job finds the order-item FK and keeps the objects (`retained_at`, spec 14 UC-ME-4, ME-4). So order history keeps its picture.
- `OrderItemDto` gains `image: ImageDto | null`, loaded with one `media.getImages` call per response.

### 8.4 Admin cancellation (S-9, answered for R2 in overview §10.4)

#### UC-OR-9 Admin cancels a seller order
- From `placed`, `accepted`, `ready_for_pickup` (the seller's own window, Q-31). `pending_payment` → `409 SELLER_ORDER_NOT_CANCELLABLE` (the expiry job handles unpaid orders); `picked_up` or later → the same error.
- The same effects as UC-OR-4, in the same lock order (§1.2): `cancelled` with the new `cancel_reason = admin_cancelled` (the `CHECK` gains the value), `cancelled_by_user_id` = the admin, `inventory.release` of the open quantities, a history row with actor `admin` and the reason, outbox `seller_order.cancelled`, order re-derived and closed if terminal (§3.9).
- Money follows from `seller_order.cancelled` exactly as for a seller cancel: payments flags a Kashier refund (spec 10), delivery cancels the shipment (spec 11 §3.5). Nothing new in those modules.
- The audit row (spec 20) is written in the same transaction.

#### UC-OR-10 Admin cancels a whole order
- Lock the order, then every seller order (§1.2). Every seller order that is not terminal must be cancellable (UC-OR-9) → else `409 ORDER_NOT_CANCELLABLE` with the blocking seller-order ids in `details`, and nothing is cancelled (OR-17).
- Each cancellable seller order is cancelled as in UC-OR-9, in id order, in the same transaction; one `seller_order.cancelled` per seller order, then the close step.
- An order with no open seller order → `409 ORDER_NOT_CANCELLABLE`.

#### Endpoints   auth: admin · rate: general · idem: **required**
| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `POST /admin/seller-orders/:sellerOrderId/cancel` | `reason str(3..500)` (OR-18) | `200` admin order detail (§4.3) | `SELLER_ORDER_NOT_FOUND` 404, `SELLER_ORDER_NOT_CANCELLABLE` 409 |
| `POST /admin/orders/:orderId/cancel` | `reason str(3..500)` | `200` admin order detail | `ORDER_NOT_FOUND` 404, `ORDER_NOT_CANCELLABLE` 409 |

The customer sees the seller order as cancelled with `cancelReason = admin_cancelled`; the admin's free-text reason is shown to admins only (OR-19). The seller is notified (spec 13 §8.2 "not cancelled by the seller").

New error code: `ORDER_NOT_CANCELLABLE` 409 (whole-order admin cancel with a seller order past `ready_for_pickup`, or nothing open).

### 8.5 Following parts of v2.0
Returns are in §8.7, coupons in §8.8.

### 8.6 Decisions (answered 2026-10-20)

The user accepted every recommendation (2026-10-20). The table is kept for the reasoning; the answers are logged in `00-overview.md` §10.10.

| # | Topic | Options / recommendation |
|---|---|---|
| OR-17 | Admin whole-order cancel when one seller order is already picked up | **Rec:** all or nothing: `409 ORDER_NOT_CANCELLABLE` naming the blocking seller orders; the admin cancels the others one by one if that is what they want · or cancel what can be cancelled and report the rest |
| OR-18 | Admin cancel reason | **Rec:** required free text (3..500), stored in the history and the audit log · or an enum of reasons plus an optional note |
| OR-19 | What the customer sees | **Rec:** `cancelReason = admin_cancelled` only, the free text stays internal (it may mention fraud checks or the seller) · or show the admin's text to the customer |

### 8.7 Returns (spec 18)

#### Tables and columns
- `order_items.returned_quantity INT NOT NULL` (existing rows filled with 0 by the migration; no DB default, G13). `CHECK (cancelled_quantity + returned_quantity <= quantity)`.
- New table `order_item_returns` (like `order_item_cancellations`): `return_id` (no FK: returns' table, a cross-module FK is allowed but returns rows are written after this one in the same transaction, so the FK is added `DEFERRABLE INITIALLY DEFERRED`, database v2.0), `order_item_id` (FK `RESTRICT`), `quantity`, `subtotal_amount`, `discount_amount`, `paid_amount`, `commission_amount`, `created_at`.
- `seller_orders` gains `returned_subtotal`, `returned_paid`, `returned_commission`, `returned_seller_net` (`NUMERIC(12,2) NOT NULL`, filled with 0). A seller order stays `delivered`; its delivered amounts stay as booked, and the returned sums sit next to them.

#### Public API additions
| Method | Caller | Notes |
|---|---|---|
| `getReturnableItems(customerId, sellerOrderId) → ReturnableSellerOrder \| null` | returns | `{ sellerOrderId, orderId, orderNumber, status, deliveredAt, paymentMethod, dropoffGovernorateId, items: { orderItemId, productName, attributes, imageMediaId, returnable, paidUnitAmount }[] }`. `returnable = quantity − cancelled − returned`. `paidUnitAmount` is indicative (the exact share for `k` units comes from the rule below) |
| `quoteReturn(sellerOrderId, lines) → ReturnAmounts` | returns (request estimate) | Reads only; same rule as `recordReturn` |
| `getReturnLogistics(sellerOrderId) → { pickup, dropoff }` | returns (approval) | `pickup` = the order's drop-off snapshot (the customer), `dropoff` = the seller order's pickup snapshot + live business name |
| `recordReturn({ sellerOrderId, returnId, lines: { orderItemId, quantity }[] }, trx) → ReturnAmounts` | returns (UC-RE-7) | Locks the order, then the seller order (§1.2). Seller order must be `delivered`; each `quantity <= returnable` → else `409 RETURN_QUANTITY_INVALID` (returns' code, raised here). Inserts `order_item_returns`, bumps `returned_quantity` and the seller order's `returned_*` sums. No outbox event (returns publishes `return.completed`) |

#### Amount rule (exact, no rounding drift)
Every amount of a line is computed over the units still **kept** (`quantity − cancelled − returned`), and an event's share is the difference between the value before and after it:
- line discount kept = `round(discount_original × kept / quantity)` (§8.8)
- `subtotal` share = `unit_price × k`; `paid` share = subtotal share − (discount kept before − discount kept after)
- commission on the seller order's kept base: platform-funded or no coupon → base = kept subtotal; seller-funded → base = kept paid subtotal; `commission_kept = round(base × commission_rate)`; `commissionReversed` = before − after
- `sellerNetReversed` = (platform-funded or no coupon ? subtotal share : paid share) − `commissionReversed`
- `platformDiscountReversed` = the discount share if the coupon is platform-funded, else 0

`ReturnAmounts = { itemsSubtotal, itemsPaid, commissionReversed, sellerNetReversed, platformDiscountReversed }`. So the reversals of several returns of one seller order add up exactly to what was booked at delivery.

#### Read changes
`OrderItemDto` gains `returnedQuantity`; seller order views gain `returnedPaid` (customer) and `returnedSubtotal`, `returnedCommission`, `returnedSellerNet` (seller, admin). `itemCount` (OR-9) counts kept units.

### 8.8 Coupons (spec 19)

#### Checkout (UC-OR-1 changes)
- Body gains `couponCode opt str(4..32)`.
- Inside the transaction, after step 4: `promotions.quote(code, customerId, lines)` (reads only) → the discount per line. Its errors abort the checkout (`422` coupon codes).
- Step 5 money: per line `discount_original`; per seller order `subtotal` (undiscounted), `discount_amount`, `discount_funding`; commission and net per §8.7 (R-17: platform-funded → `round(subtotal × rate)`, net = subtotal − commission; seller-funded → `round((subtotal − discount) × rate)`, net = subtotal − discount − commission); `items_total = Σ (subtotal − discount)` of the seller orders that count (OR-13); `discount_total`; `total = items_total + delivery_fee`. `expectedTotal` is compared with this total (S-8).
- After step 8 (`payments.createForOrder`): `promotions.redeem(…, trx)` (spec 19 UC-PR-2). Lock order: `carts → orders → seller_orders → inventory_items → payments → coupons` (OR-3 extended).
- Close step (§3.9): when the order closes `cancelled`, `promotions.release(orderId, trx)` (R-18), still the last lock.

#### Columns
- `orders`: `coupon_id` (nullable FK → `coupons`, `RESTRICT`; `null` = no coupon), `coupon_code VARCHAR(32) NULL` (snapshot), `discount_total NUMERIC(12,2) NOT NULL` (`CHECK >= 0`; `coupon_id IS NULL ⇒ discount_total = 0`).
- `seller_orders`: `discount_amount NUMERIC(12,2) NOT NULL`, `discount_funding VARCHAR(10) NULL` (`CHECK` set ⇔ `discount_amount > 0`).
- `order_items`: `discount_original NUMERIC(12,2) NOT NULL` (`CHECK <= unit_price × quantity`), `discount_amount NUMERIC(12,2) NOT NULL` (the kept share, rule §8.7). Existing rows are filled with 0.

#### Cancellations with a coupon (R-18)
Partial and whole cancellations keep the redemption. The cancelled units' discount share simply goes away with them: `amountCancelled` and the line amounts in the events are **paid** amounts (after discount), so the Kashier refund and the COD reduction are what the customer actually paid for those units.

#### Event payload changes (spec 02 §6.5)
Amounts that payments and delivery treat as customer money are paid amounts: `codItemsAmount`, `amountCancelled`, `lines[].amount`, `seller_order.returned.subtotal`, `order.closed.deliveredItemsTotal`. `seller_order.items_cancelled` gains `newPaidSubtotal` (delivery uses it for the COD amount). `seller_order.delivered` gains `discountAmount`, `discountFunding`, `platformDiscount`. Without a coupon every paid amount equals the R1 amount, so R1 consumers keep working; they switch to the new fields before coupons ship.

#### Read changes
`OrderDetailDto` gains `coupon: { code, discountTotal } | null`; seller orders gain `discountAmount`, `discountFunding`; `OrderItemDto` gains `discountAmount`, `paidTotal`. The seller sees `discountAmount` and `discountFunding` on `SellerOrderDto` (PR-7).

### 8.9 Decisions (answered 2026-10-20)

The user accepted every recommendation (2026-10-20). The table is kept for the reasoning; the answers are logged in `00-overview.md` §10.11.

| # | Topic | Options / recommendation |
|---|---|---|
| OR-20 | Where return amounts are computed | **Rec:** in ordering (`quoteReturn` / `recordReturn`), which owns every money snapshot; returns only stores and forwards them · or in returns from snapshot data ordering hands over |
| OR-21 | Seller-order status after a return | **Rec:** stays `delivered`; returned quantities and sums sit next to the delivered amounts · or a new status `partially_returned` / `returned` |
| OR-22 | Event semantics with coupons | **Rec:** the existing customer-money fields carry paid amounts (equal to R1 values without a coupon), new fields for the undiscounted parts, version stays 1, consumers deployed first · or version-2 events for every changed payload |

### 8.10 Clarifications (R2-P2 implementation, approved 2026-10-20)

| # | Clarification | Where |
|---|---|---|
| OR-23 | `getNotificationParties` returns **each order once**, whether it was named by `orderIds`, by one or more of its `sellerOrderIds`, or both, and always with **all** its seller orders (oldest first). The caller picks the seller order it cares about by id. Unknown ids are left out; an empty request returns `[]` | §8.1 |
| OR-24 | `getCustomerOrderLink` answers `sellerOrderId: null` when none was asked for. A customer may link an order in any status, `pending_payment` included (the customer sees it in their history); only `getSellerOrderLink` hides `pending_payment` (§4.2) | §8.1 |
| OR-25 | `seller_order.accepted` is written only by a successful accept, in its transaction; a refused repeat (`409`) writes nothing. `acceptedAt` equals the stored `accepted_at` | §8.2 |
