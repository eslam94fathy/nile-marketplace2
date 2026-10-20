# Spec 02 — Domain Events Catalogue (Release 1)

Status: **v1.1 APPROVED (2026-10-12).** v1.0 approved by the user 2026-10-08. v1.1: `seller_order.items_cancelled` carries `previousStatus` (E-8). It replaces the event list in `00-overview.md` §7 and the event names in `01-architecture.md` §3/§5 (differences in §5 below). Changes from now on need explicit approval and a version bump.
**v1.2 APPROVED (2026-10-20):** §6 adds the Release 2 events of specs 03, 09, 13, 14, 15, 16; §6.4 (2026-10-20) those of specs 06, 17, 20; §6.5 those of specs 09 §8.7–8.8, 10, 11, 18, 19. Kept as its own section, so every cross-reference stays valid (R2-Q1).
Contracts live in `src/lib/events/contracts/` (architecture §2), one file per event: name constant + payload type + version.

---

## 1. Envelope (architecture §5, unchanged)

```ts
interface EventEnvelope<T> {
  eventId: string;        // = events_outbox.id (UUID v7)
  eventType: string;      // routing key, e.g. "seller_order.delivered"
  version: number;        // payload schema version, starts at 1
  occurredAt: string;     // ISO-8601 UTC
  correlationId: string | null;
  aggregateType: string;  // e.g. "seller_order"
  aggregateId: string;
  payload: T;
}
```
- Amounts in payloads are money **strings**. Ids are UUID strings.
- **Versioning:** adding an optional field is non-breaking (same version). Anything else is a new `version`, and the publisher emits both versions until every consumer has moved over.
- Consumers: idempotent on `eventId` (`processed_events`), state-machine guarded, and they treat the event as a **trigger**. Wherever a consumer maintains a projection of another module's state, it **re-reads the current state** through that module's public API instead of trusting the payload, so out-of-order delivery can't leave a stale value (architecture §3.2).

## 2. Catalogue

| Event | Publisher | Aggregate | Consumers (queue) |
|---|---|---|---|
| `notification.email_requested` | identity | user | notifications (`notifications.email`) |
| `seller.approved` | sellers | seller | catalog (`catalog.listing-projections`) |
| `seller.suspended` | sellers | seller | catalog (`catalog.listing-projections`) |
| `inventory.stock_status_changed` | inventory | inventory_item | catalog (`catalog.listing-projections`) |
| `order.placed` | ordering | order | none in R1 (audit, R2 notifications) |
| `seller_order.ready_for_pickup` | ordering | seller_order | delivery (`delivery.seller-order-updates`) |
| `seller_order.items_cancelled` | ordering | seller_order | delivery (`delivery.seller-order-updates`), payments (`payments.order-adjustments`) |
| `seller_order.cancelled` | ordering | seller_order | delivery (`delivery.seller-order-updates`), payments (`payments.order-adjustments`) |
| `seller_order.returned` | ordering | seller_order | delivery (`delivery.seller-order-updates`), payments (`payments.order-adjustments`) |
| `seller_order.delivered` | ordering | seller_order | payments (`payments.order-adjustments`), finance (`finance.ledger`) |
| `order.closed` | ordering | order | payments (`payments.order-adjustments`), finance (`finance.ledger`) |
| `payment.paid` | payments | payment | ordering (`ordering.payment-updates`) |
| `payment.failed` | payments | payment | ordering (`ordering.payment-updates`) |
| `payment.expired` | payments | payment | none in R1 (written inside ordering's expiry transaction, which already did the work) |
| `payment.refund_recorded` | payments | payment | none in R1 |
| `shipment.assigned` | delivery | shipment | none in R1 (R2 push notification to the agent) |
| `shipment.picked_up` | delivery | shipment | ordering (`ordering.shipment-updates`) |
| `shipment.out_for_delivery` | delivery | shipment | ordering (`ordering.shipment-updates`) |
| `shipment.attempt_failed` | delivery | shipment | ordering (`ordering.shipment-updates`) |
| `shipment.delivered` | delivery | shipment | ordering (`ordering.shipment-updates`) |
| `cod.remittance_confirmed` | finance | cod_remittance | none in R1 |
| `payout.recorded` | finance | payout | none in R1 |

Queue bindings (`nile.events` topic exchange):

| Queue | Binding keys |
|---|---|
| `notifications.email` | `notification.email_requested` |
| `catalog.listing-projections` | `seller.approved`, `seller.suspended`, `inventory.stock_status_changed` |
| `delivery.seller-order-updates` | `seller_order.ready_for_pickup`, `seller_order.items_cancelled`, `seller_order.cancelled`, `seller_order.returned` |
| `payments.order-adjustments` | `seller_order.items_cancelled`, `seller_order.cancelled`, `seller_order.returned`, `seller_order.delivered`, `order.closed` |
| `finance.ledger` | `seller_order.delivered`, `order.closed` |
| `ordering.payment-updates` | `payment.paid`, `payment.failed` |
| `ordering.shipment-updates` | `shipment.picked_up`, `shipment.out_for_delivery`, `shipment.attempt_failed`, `shipment.delivered` |

Events with no consumer in R1 are still published. They are cheap, they give an audit trail in the outbox, and R2 consumers can bind to them without a publisher change.

## 3. Payloads (all `version: 1`)

### 3.1 identity
```ts
// notification.email_requested — aggregate: user
{
  template: 'email_verification' | 'password_reset' | 'account_invite';
  userId: string;
  toEmail: string;
  variables:                                    // non-secret, per template
    | { expiresInMinutes: number }                                    // email_verification, password_reset
    | { role: UserRole; expiresAt: string };                          // account_invite
  encryptedSecrets: string;                     // AES-256-GCM of the secret variables (see below)
}
```
**Secret variables are encrypted (S-1).** The secret part (`{ otp }` or `{ inviteUrl }`) is never stored in plain text in `events_outbox.payload` or sent in plain text over RabbitMQ.
- Format: `v1.<keyId>.<iv>.<ciphertext>.<authTag>` (base64url parts). The IV is 12 random bytes per message. AAD = `userId + ':' + template`, so a ciphertext can't be moved to another user or template.
- Keys come from env (no defaults): `SECRETS_ENCRYPTION_KEYS` (JSON map `keyId → base64 32-byte key`) and `SECRETS_ENCRYPTION_ACTIVE_KEY_ID`. To rotate, add a new key, switch the active id, and remove the old key once the outbox retention period (DB-Q5) has passed.
- Only identity encrypts and only notifications decrypts, through a `pkg/crypto` `ISecretBox` interface. A decryption failure is a permanent error (`error` log `SECRET_DECRYPT_FAILED`, message sent to the DLQ). The plain text is never logged.

### 3.2 sellers
```ts
// seller.approved — first approval AND reinstatement after suspension
{ sellerId: string; userId: string; previousStatus: 'pending_approval' | 'suspended' }
// seller.suspended
{ sellerId: string; userId: string; reason: string }
```
Consumer rule (catalog): re-read the seller status through `sellers.getStatuses([sellerId])` and set `products.seller_active` from it.

### 3.3 inventory
```ts
// inventory.stock_status_changed — published only when sellable stock crosses 0 (in either direction)
{ variantId: string; inStock: boolean }
```
Consumer rule (catalog): map the variant to its product, re-read the sellable stock of all its active variants through `inventory.getStockByVariantIds`, and recompute `products.in_stock`.

### 3.4 ordering
```ts
// order.placed — COD: at checkout. Kashier: when payment.paid is applied
{ orderId: string; orderNumber: string; customerId: string; paymentMethod: PaymentMethod;
  sellerOrderIds: string[]; itemsTotal: string; deliveryFee: string; total: string; placedAt: string }

// seller_order.ready_for_pickup — the shipment is created from this snapshot
{ sellerOrderId: string; orderId: string; orderNumber: string; sellerId: string;
  paymentMethod: PaymentMethod;
  codItemsAmount: string;          // COD: current seller order subtotal. Kashier: "0.00"
  orderDeliveryFee: string;        // COD fee of the whole checkout (used by the fee carrier). Kashier: "0.00"
  pickup:  { businessName: string; phone: string; governorateId: string; city: string; area: string;
             street: string; building: string; landmark: string | null };
  dropoff: { recipientName: string; recipientPhone: string; governorateId: string; governorateName: string;
             city: string; area: string; street: string; building: string;
             floor: string | null; apartment: string | null; landmark: string | null };
  readyAt: string }

// seller_order.items_cancelled — seller cancelled some quantities; the seller order stays open
{ sellerOrderId: string; orderId: string; sellerId: string; paymentMethod: PaymentMethod;
  previousStatus: SellerOrderStatus; // status when the items were cancelled (unchanged by it) [v1.1, E-8]
  lines: { orderItemId: string; variantId: string; quantity: number; amount: string }[];
  amountCancelled: string;          // Σ lines.amount
  newSubtotal: string; newCommission: string; newSellerNet: string;
  reason: 'out_of_stock' | 'seller_request' | 'other' }

// seller_order.cancelled
{ sellerOrderId: string; orderId: string; sellerId: string; paymentMethod: PaymentMethod;
  previousStatus: SellerOrderStatus;
  reason: 'customer_cancelled' | 'seller_cancelled' | 'seller_acceptance_timeout' | 'payment_failed' | 'payment_expired';
  amountCancelled: string;          // subtotal at the time of cancellation
  cancelledAt: string }

// seller_order.returned — seller confirmed the parcel came back
{ sellerOrderId: string; orderId: string; sellerId: string; paymentMethod: PaymentMethod;
  subtotal: string; returnedAt: string }

// seller_order.delivered — one event carries every amount the ledger needs (finance books it atomically)
{ sellerOrderId: string; orderId: string; sellerId: string; paymentMethod: PaymentMethod;
  subtotal: string; commissionRate: string; commission: string; sellerNet: string;
  agentId: string;
  agentFeeShare: string;            // computed by ordering, spec 09 §4.6
  codCollectedAmount: string | null;// COD: cash the agent took (items + fee if this shipment carried it). Kashier: null
  deliveryFeeCollected: boolean;    // COD: this shipment carried (and collected) the checkout's fee
  deliveryFeeAmount: string;        // the fee collected by this shipment, "0.00" if none
  deliveredAt: string }

// order.closed — every seller order of the checkout is terminal
{ orderId: string; customerId: string; paymentMethod: PaymentMethod;
  finalStatus: 'completed' | 'partially_completed' | 'cancelled';
  deliveredItemsTotal: string;      // Σ subtotals of delivered seller orders
  deliveryFee: string;              // final fee: "0.00" when nothing was delivered (Q-28)
  originalDeliveryFee: string;      // fee snapshotted at checkout
  closedAt: string }
```

### 3.5 payments
```ts
// payment.paid
{ paymentId: string; orderId: string; amount: string; paidAt: string;
  lateAfterExpiry: boolean }        // SD-5: true → the order stays cancelled, a full refund is flagged
// payment.failed
{ paymentId: string; orderId: string; reason: 'amount_mismatch' | 'order_reference_mismatch' }
// payment.expired
{ paymentId: string; orderId: string; expiredAt: string }
// payment.refund_recorded
{ paymentId: string; orderId: string; refundId: string; amount: string;
  newPaymentStatus: 'partially_refunded_manually' | 'refunded_manually'; recordedByUserId: string }
```

### 3.6 delivery
```ts
// shipment.assigned
{ shipmentId: string; sellerOrderId: string; agentId: string; previousAgentId: string | null;
  assignedBy: 'auto' | 'admin' }
// shipment.picked_up
{ shipmentId: string; sellerOrderId: string; orderId: string; agentId: string; pickedUpAt: string }
// shipment.out_for_delivery
{ shipmentId: string; sellerOrderId: string; orderId: string; agentId: string; attemptNumber: 1 | 2 | 3 }
// shipment.attempt_failed
{ shipmentId: string; sellerOrderId: string; orderId: string; agentId: string; attemptNumber: 1 | 2 | 3;
  reason: 'customer_unreachable' | 'customer_refused' | 'wrong_address' | 'customer_rescheduled';
  returningToSeller: boolean }      // true when refused or after the 3rd attempt
// shipment.delivered
{ shipmentId: string; sellerOrderId: string; orderId: string; agentId: string;
  codCollectedAmount: string | null; deliveryFeeCollected: boolean; deliveryFeeAmount: string; deliveredAt: string }
```

### 3.7 finance
```ts
// cod.remittance_confirmed
{ remittanceId: string; agentId: string; amount: string; confirmedByUserId: string }
// payout.recorded
{ payoutId: string; payeeType: 'seller' | 'agent'; payeeId: string; amount: string; recordedByUserId: string }
```

## 4. End-to-end flows (who emits what)

```
COD checkout ─► order.placed
Kashier checkout ─► (webhook) payment.paid ─► ordering: placed ─► order.placed
seller accept ─► (no event)        seller ready ─► seller_order.ready_for_pickup ─► delivery: shipment + auto-assign ─► shipment.assigned
agent picked up ─► shipment.picked_up ─► ordering: picked_up
agent out ─► shipment.out_for_delivery ─► ordering: out_for_delivery
agent failed ─► shipment.attempt_failed ─► ordering: delivery_failed | returning_to_seller
seller return received ─► seller_order.returned ─► delivery: returned_to_seller · payments: refund (Kashier) / amount (COD)
agent delivered ─► shipment.delivered ─► ordering: delivered + inventory.commit ─► seller_order.delivered ─► finance ledger · payments COD collected
last seller order terminal ─► order.closed ─► finance: platform delivery revenue · payments: fee refund / final COD status
```

## 5. Differences from the approved docs (need approval)

| # | Approved doc says | This catalogue | Why |
|---|---|---|---|
| E-1 | Overview §7: `seller_order.status_changed`, `order.status_changed` | Specific events: `seller_order.ready_for_pickup / items_cancelled / cancelled / returned / delivered`, `order.closed` | Consumers bind only to the transitions they need. Architecture §3/§5 already used the specific names |
| E-2 | Overview §7: `shipment.ready_for_assignment` | `seller_order.ready_for_pickup` | Same as architecture §3. Ordering owns the trigger |
| E-3 | Overview §7: `cod.collected`; architecture §5 binds it to `finance.ledger` | Folded into `shipment.delivered` / `seller_order.delivered` (`codCollectedAmount`) | Cash is collected exactly when a shipment is delivered. One event lets finance book the whole delivery atomically |
| E-4 | Overview §7: `shipment.returned` | Removed. The return completes when the **seller** confirms receipt (ordering), which emits `seller_order.returned` | Overview §4.7: the seller confirms |
| E-5 | Overview §7: `inventory.reservation_expired` | Removed. Architecture §6: the expiry job releases stock synchronously in its own transaction | No consumer needs it |
| E-6 | Architecture §5: `finance.ledger` ← `seller_order.cancelled`, `payment.refund_recorded` | `finance.ledger` ← `seller_order.delivered`, `order.closed` only | Nothing is booked in the ledger before delivery, so cancellations and refunds of undelivered orders have no ledger effect in R1 |
| E-7 | – | New: `notification.email_requested`, `inventory.stock_status_changed`, `order.closed`, `payout.recorded` | `notification.email_requested` and `inventory.stock_status_changed` were already in architecture §3. `order.closed` drives the fee rules (Q-28) |
| E-8 | – | `seller_order.items_cancelled.previousStatus` (additive, still version 1; approved 2026-10-12) | Items can be cancelled while `ready_for_pickup`. If the event overtakes `seller_order.ready_for_pickup`, delivery must retry it instead of acking, or the shipment keeps the old COD amount (spec 11 DE-15) |

---

## 6. Release 2 events [v1.2, approved 2026-10-20]

### 6.1 New events

| Event | Publisher | Aggregate | Consumers (queue) |
|---|---|---|---|
| `user.suspended` | identity | user | realtime (`realtime.fanout`), notifications (`notifications.user-events`) |
| `user.sessions_revoked` | identity | user | notifications (`notifications.user-events`) |
| `seller_order.accepted` | ordering | seller_order | realtime, notifications |
| `media.uploaded` | media | media_object | media (`media.processing`) |
| `media.ready` | media | media_object | realtime |
| `media.failed` | media | media_object | realtime |
| `support.ticket_opened` | support | support_ticket | realtime |
| `support.message_created` | support | support_ticket | realtime, notifications |
| `support.ticket_assigned` | support | support_ticket | realtime |
| `support.ticket_status_changed` | support | support_ticket | realtime, notifications |
| `notification.push_requested` | notifications | user_notification | notifications (`notifications.push`) |

Existing events gain consumers. `order.placed`, `order.closed`, every `seller_order.*`, `payment.paid` / `failed` / `expired` and `shipment.*` now also go to `realtime.fanout` and, per spec 13 §8.2, to `notifications.user-events`. No publisher changes, as §2 intended ("R2 consumers can bind to them without a publisher change").

New queues:

| Queue | Binding keys |
|---|---|
| `media.processing` | `media.uploaded` |
| `realtime.fanout` | spec 15 §5 list |
| `notifications.user-events` | spec 13 §8.2 events, `user.suspended`, `user.sessions_revoked` |
| `notifications.push` | `notification.push_requested` |

### 6.2 Payloads (all `version: 1`)
```ts
// identity
// user.suspended
{ userId: string; role: UserRole; suspendedAt: string }
// user.sessions_revoked
{ userId: string; reason: 'password_reset'; revokedAt: string }

// ordering: the seller accepted; nothing else changes (no money or stock effect)
// seller_order.accepted
{ sellerOrderId: string; orderId: string; orderNumber: string; sellerId: string; customerId: string; acceptedAt: string }

// media
// media.uploaded
{ mediaId: string; purpose: MediaPurpose; ownerUserId: string }
// media.ready
{ mediaId: string; purpose: MediaPurpose; ownerUserId: string }
// media.failed
{ mediaId: string; purpose: MediaPurpose; ownerUserId: string; reason: MediaFailureReason }

// support
// support.ticket_opened
{ ticketId: string; ticketNumber: string; openerUserId: string; openerRole: 'customer' | 'seller'; category: TicketCategory }
// support.message_created
{ ticketId: string; ticketNumber: string; messageId: string; kind: 'message' | 'internal_note' | 'system';
  senderRole: 'customer' | 'seller' | 'admin' | 'system'; openerUserId: string; assignedAdminUserId: string | null }
// support.ticket_assigned
{ ticketId: string; openerUserId: string; assignedAdminUserId: string | null; previousAdminUserId: string | null }
// support.ticket_status_changed
{ ticketId: string; ticketNumber: string; openerUserId: string; from: TicketStatus; to: TicketStatus;
  actor: 'admin' | 'customer' | 'seller' | 'system' }

// notifications (internal)
// notification.push_requested
{ notificationId: string; userId: string }
```

### 6.3 Recipient resolution
`order.placed` and the `seller_order.*` / `shipment.*` payloads don't always name the user to notify. For example, `order.placed` lists `sellerOrderIds` but not their sellers, and the shipment events carry no customer.
- Realtime and notifications resolve recipients through a new batched ordering method, `getNotificationParties(sellerOrderIds | orderIds)` → `{ orderId, orderNumber, customerId, sellerOrders: { sellerOrderId, sellerId, status }[] }` (spec 09 v2.0), plus the profile → user id lookups of customers, sellers and delivery.
- This follows the §1 rule: re-read, don't trust the payload, so out-of-order events still show the current status.

### 6.4 Reviews, product block, admin cancellation [2026-10-20]

| Event | Publisher | Aggregate | Consumers (queue) |
|---|---|---|---|
| `review.created` | reviews | product_review | notifications (`notifications.user-events`, RV-8) |
| `review.replied` | reviews | product_review | notifications (RV-8) |
| `review.rating_changed` | reviews | product (rating stats) | catalog (`catalog.listing-projections`), sellers (`sellers.rating-projection`, new) |
| `product.blocked` | catalog | product | notifications (BO-8) |
| `product.unblocked` | catalog | product | notifications (BO-8) |

```ts
// reviews
// review.created
{ reviewId: string; productId: string; sellerId: string; customerId: string; rating: number }
// review.replied
{ reviewId: string; productId: string; customerId: string }
// review.rating_changed: absolute aggregates + a version per subject (spec 17 §1.2); consumers apply only newer versions
{ product: { productId: string; ratingCount: number; ratingSum: number; version: number };
  seller:  { sellerId: string;  ratingCount: number; ratingSum: number; version: number } }

// catalog
// product.blocked / product.unblocked
{ productId: string; sellerId: string; at: string }
```

- `seller_order.cancelled.reason` gains the value `admin_cancelled` (spec 09 §8.4). Additive, still version 1. Payments and delivery treat it exactly like `seller_cancelled`; their payload parsers must accept the new value before ordering ships it (R2 deploy order: consumers first).
- New queue `sellers.rating-projection` (binding `review.rating_changed`). `catalog.listing-projections` adds the binding `review.rating_changed`.

### 6.5 Returns, refunds, coupons [2026-10-20]

| Event | Publisher | Aggregate | Consumers (queue) |
|---|---|---|---|
| `return.status_changed` | returns | return_request | realtime, notifications, delivery (`delivery.return-updates`) |
| `return.approved` | returns | return_request | delivery (`delivery.return-updates`) |
| `return.completed` | returns | return_request | payments (`payments.order-adjustments`), finance (`finance.ledger`) |
| `return_shipment.picked_up` | delivery | shipment | returns (`returns.shipment-updates`), realtime |
| `return_shipment.delivered` | delivery | shipment | returns, realtime |
| `return_shipment.failed` | delivery | shipment | returns, realtime |
| `payment.refunded` | payments | payment | finance, notifications, realtime |

Payloads are in spec 18 §5, spec 11 §8.2 and spec 10 §8.6. `return.completed.refundPayoutEncrypted` is encrypted with the S-1 key like the secret email variables (§3.1).

Changed payloads (additive, still version 1; consumers deployed before the publisher, spec 09 OR-22):
- `shipment.assigned` += `kind`, `returnId`.
- `seller_order.items_cancelled` += `newPaidSubtotal`; `lines[].amount` and `amountCancelled` are paid amounts.
- `seller_order.cancelled.amountCancelled`, `seller_order.ready_for_pickup.codItemsAmount`, `seller_order.returned.subtotal`, `order.closed.deliveredItemsTotal` are paid amounts.
- `seller_order.delivered` += `discountAmount`, `discountFunding: 'platform' | 'seller' | null`, `platformDiscount`.
- `payment.refund_recorded` += `reason`, `returnId`, `customerId`; `newPaymentStatus` per spec 10 §8.6. `payment.refunded` carries `customerId` too.

New queues: `returns.shipment-updates`, `delivery.return-updates`. `payments.order-adjustments` and `finance.ledger` bind `return.completed`; `finance.ledger` binds `payment.refunded`, `payment.refund_recorded`.
