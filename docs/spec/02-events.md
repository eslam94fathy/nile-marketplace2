# Spec 02 — Domain Events Catalogue (Release 1)

Status: **v1.0 APPROVED (2026-10-08).** Approved by the user. It replaces the event list in `00-overview.md` §7 and the event names in `01-architecture.md` §3/§5 (differences in §5 below). Changes from now on need explicit approval and a version bump.
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
