# Spec 09 — ordering

Status: **DRAFT v0.1 (2026-10-08), under review.** [PROPOSED] unless it restates overview §4.3 / §5.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Checkout (the orchestrator), the order and its per-seller split, snapshots, stored statuses, cancellations (whole and partial), the 24 h acceptance timeout, Kashier payment expiry, and the money of each seller order (subtotal, commission, net, agent fee share).
Tables: `orders`, `seller_orders`, `order_items`, `order_item_cancellations`, `order_status_history`, `seller_order_status_history`.
Depends on (sync): `customers`, `cart`, `catalog`, `sellers`, `inventory`, `payments`, `delivery` (fee + agent-share setting only). **No module calls ordering** (architecture §2).

Config: `SELLER_ACCEPT_TIMEOUT_HOURS` (24), `KASHIER_PAYMENT_TTL_MINUTES` (15), job intervals (architecture §6).

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
Every write that touches a checkout locks **the `orders` row first** (`SELECT … FOR UPDATE`), then its seller orders, then calls inventory (which locks items sorted by id). One lock order everywhere → no deadlocks. It also serialises the status derivation and the agent-share remainder (§3.8) per checkout. Every seller-order transition is a conditional update on the expected status. 0 rows → `SELLER_ORDER_INVALID_STATUS_TRANSITION` (HTTP) or a guarded no-op with a `warn` log (consumers).

## 2. Public API (`index.ts`)
None. Only event contracts (in `lib/events/contracts`).

## 3. Use cases

### 3.1 UC-OR-1 Checkout (architecture §7.1)
Pre-transaction (reads):
1. `customers.getAddressSnapshot(customerId, addressId)`. `delivery.getGovernorateFees([governorateId])` → `null` fee → `GOVERNORATE_NOT_DELIVERABLE`.
2. `delivery.getAgentFeeShareRate()`.

One transaction:
3. `cart.getLinesForCheckout(customerId, trx)` (locks the cart). Empty → `CART_EMPTY`.
4. `catalog.getVariantsForPurchase(ids, trx)`, `sellers.getCheckoutSnapshots(sellerIds, trx)`. Any variant not purchasable or seller not `approved` → `CART_HAS_ISSUES` (details: the variant ids).
5. Money (`Money`, overview §5): `line_total = price × qty`; per seller `subtotal`, `commission = round(subtotal × rate)`, `seller_net`; `items_total`; `delivery_fee`; `total`. `total ≠ expectedTotal` → `ORDER_TOTAL_CHANGED` (details: the current total) (S-8).
6. Insert `orders` (`order_number` from the sequence), `seller_orders` (pickup snapshot, commission snapshot), `order_items` (snapshots, `cancelled_quantity = 0`) as multi-row inserts, and the history rows.
   - COD: order + seller orders `placed`, `placed_at = now()`, `accept_deadline_at = now() + 24 h`.
   - Kashier: `pending_payment`, `payment_expires_at = now() + 15 min`, no deadline yet.
7. `inventory.reserve(lines with orderItemId, trx)` → `INSUFFICIENT_STOCK` rolls everything back.
8. `payments.createForOrder({ orderId, method, amount: total }, trx)`.
9. `cart.clear(customerId, trx)`.
10. COD: outbox `order.placed`.
11. Commit. Kashier: `payments.createKashierSession(orderId)` **after** commit; if it fails, `checkoutUrl = null` and the app calls §4.1.2 (SD-5).

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
- **seller-acceptance-timeout:** `placed` seller orders with `accept_deadline_at < now()`, batch, `FOR UPDATE SKIP LOCKED` (after locking their orders) → like UC-OR-4 with `seller_acceptance_timeout`, actor `system`.
- **kashier-payment-expiry:** orders `pending_payment` with `payment_expires_at < now()`:
  1. Outside any transaction: `payments.fetchProviderStatus(orderId)` (asks Kashier, SD-5).
  2. Provider says paid → `payments.markPaidFromProvider(...)`, skip (the normal `payment.paid` flow places the order).
  3. Otherwise one transaction: `payments.expire(orderId, trx)` (conditional `initiated → expired`; 0 rows = the webhook won, skip) → all seller orders `cancelled` (`payment_expired`), `inventory.release`, order closed as `cancelled` (fee 0). Outbox: `seller_order.cancelled` ×n, `order.closed`.
  4. Provider unreachable → expire anyway (a late success is handled by SD-5).

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
Errors: `CART_EMPTY` 422, `CART_HAS_ISSUES` 409, `ADDRESS_NOT_FOUND` 422, `GOVERNORATE_NOT_DELIVERABLE` 422, `ORDER_TOTAL_CHANGED` 409, `INSUFFICIENT_STOCK` 409, idempotency errors.

#### 4.1.2 `POST /orders/:orderId/payment/kashier-session`   rate: checkout
Creates (or returns the still-valid) Kashier session through `payments`. `200 { checkoutUrl: string; expiresAt: string }`.
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
    canCancel: boolean;                                    // status === 'placed'
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
