# Spec 10 — payments

Status: **DRAFT v0.1 (2026-10-08), under review.** [PROPOSED] unless it restates overview §4.4 / SD-5.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

One payment per checkout (Q-9): COD and Kashier. Kashier sessions, the signed webhook, payment expiry (called by ordering's job), COD collection tracking, refund flags and admin recording of manual refunds (R1 refunds are done by hand in the Kashier dashboard).
Tables: `payments`, `payment_refunds`, `payment_events`.
Depends on: nothing (it calls Kashier over HTTP through a `pkg/payments` gateway interface, never inside a DB transaction).

Enums:
- `PaymentStatus` COD: `pending, partially_collected, collected, cancelled` (`cancelled` is new, S-12) · Kashier: `initiated, paid, failed, expired, partially_refunded_manually, refunded_manually`
- `RefundReason`: `seller_order_cancelled, items_cancelled, delivery_failed, late_payment_after_expiry, all_cancelled_fee` · `RefundStatus`: `pending_manual, recorded`

Config: `KASHIER_MERCHANT_ID`, `KASHIER_API_KEY`, `KASHIER_SECRET_KEY` (webhook signature), `KASHIER_BASE_URL`, `KASHIER_MODE` (`test|live`), `KASHIER_REDIRECT_URL` (app deep link), `KASHIER_WEBHOOK_URL`, HTTP timeout.

> The Kashier request/response fields, the webhook signature scheme (header name, signed fields, algorithm) and the session-expiry option must be confirmed against Kashier's current documentation at implementation time. This spec fixes **our** behaviour; the gateway adapter maps it to Kashier's API.

## 2. Public API (`index.ts`)

| Method | Caller | Behaviour |
|---|---|---|
| `createForOrder({ orderId, method, amount }, trx)` | ordering (checkout) | COD → `pending`, Kashier → `initiated`. `collected_amount = 0`, `refunded_amount = 0` |
| `createKashierSession(orderId, expiresAt) → { checkoutUrl, expiresAt }` | ordering | **Outside a transaction.** Calls Kashier with `merchantOrderId = payments.id`, amount, EGP, expiry. Stores `provider_order_ref`. Throws `PAYMENT_PROVIDER_UNAVAILABLE` on timeout/5xx |
| `fetchProviderStatus(orderId) → 'paid' \| 'unpaid' \| 'unknown'` | ordering (expiry job) | Outside a transaction |
| `markPaidFromProvider(orderId, providerData)` | ordering (expiry job) | Same effect as a success webhook (UC-PA-2) |
| `expire(orderId, trx) → boolean` | ordering (expiry job) | Conditional `initiated → expired`. `false` = it wasn't `initiated` any more (the webhook won). Outbox `payment.expired` |
| `getSummaries(orderIds) → { orderId, method, status, amount, collectedAmount, refundedAmount }[]` | ordering (order views) | Batched |

## 3. Use cases

### UC-PA-1 Kashier webhook (architecture §7.2)
1. Verify the signature over the **raw body** with `KASHIER_SECRET_KEY` (constant-time compare). Invalid → `401 INVALID_WEBHOOK_SIGNATURE`, `warn` log without the payload.
2. Insert `payment_events` (payload with card data stripped). `uq_payment_events_provider_provider_event_id` duplicate → `200`, done.
3. Find the payment by `merchantOrderId` (= `payments.id`). Unknown → `error` log `KASHIER_UNKNOWN_ORDER`, `200` (so Kashier stops retrying).
4. By event outcome:
   - **Success:** amount ≠ `payments.amount` → `failed` + `error` log `PAYMENT_AMOUNT_MISMATCH` + outbox `payment.failed (amount_mismatch)`. Otherwise UC-PA-2.
   - **Failure / declined:** recorded in `payment_events` only. The payment stays `initiated`, so the customer can retry inside the 15 min window; expiry cancels it (S-4).
   - **Refund notifications** from Kashier (if any): recorded only. R1 refunds are recorded by an admin (UC-PA-4).
5. Mark the event `processed_at`. Respond `200 { "received": true }`.

### UC-PA-2 Apply a successful payment
Conditional update by current status:
- `initiated → paid`, `collected_amount = amount`, `paid_at`, `provider_transaction_ref`. Outbox `payment.paid (lateAfterExpiry = false)`.
- `expired → paid` (SD-5): same, **plus** a `payment_refunds` row for the full amount (`late_payment_after_expiry`, `pending_manual`). Outbox `payment.paid (lateAfterExpiry = true)`. The order stays cancelled.
- Already `paid` → no-op.

### UC-PA-3 Order adjustments (consumer `payments.order-adjustments`)
| Event | Kashier (only if the payment is `paid` or partially refunded) | COD |
|---|---|---|
| `seller_order.items_cancelled` | refund row `amountCancelled`, `items_cancelled`, `seller_order_id` | `amount −= amountCancelled` |
| `seller_order.cancelled` | refund row `amountCancelled`, `seller_order_cancelled` | `amount −= amountCancelled` |
| `seller_order.returned` | refund row `subtotal`, `delivery_failed` | `amount −= subtotal` |
| `seller_order.delivered` | – | `collected_amount += codCollectedAmount`, `pending → partially_collected` |
| `order.closed` | if `deliveryFee = 0` and `originalDeliveryFee > 0`: refund row `originalDeliveryFee`, `all_cancelled_fee` | Expected = `deliveredItemsTotal + deliveryFee`. `collected_amount = expected` → OK. `collected_amount = deliveredItemsTotal` (fee never collected, S-3) → `warn COD_DELIVERY_FEE_UNCOLLECTED`. Anything else → `error COD_AMOUNT_MISMATCH` (investigated manually). Then `amount = collected_amount`, status `collected` if `> 0`, else `cancelled` |

A Kashier payment that never got paid (`initiated`, `expired`, `failed`) ignores all of these.

### UC-PA-4 Admin records a manual refund
After refunding in the Kashier dashboard, the admin records it: refund `pending_manual → recorded`, `recorded_by_user_id`, `recorded_at`, `provider_refund_ref`. Payment: `refunded_amount += amount` (`CHECK refunded_amount <= collected_amount`), status `refunded_manually` if `refunded_amount = collected_amount`, else `partially_refunded_manually`. Outbox `payment.refund_recorded`. One transaction, payment row `FOR UPDATE`.

## 4. Endpoints

### 4.1 `POST /webhooks/kashier`   auth: webhook (signature) · rate: none (body-size limited) · idem: – (deduped on the provider event id)
Raw body; no DTO whitelist (the provider's schema is validated by a lenient parser that reads only the fields we need).
`200 { "received": true }`. Errors: `INVALID_WEBHOOK_SIGNATURE` 401.

### 4.2 Admin   auth: admin · rate: general
```ts
interface RefundDto {
  id: string; paymentId: string; orderId: string; sellerOrderId: string | null;
  amount: string; reason: RefundReason; status: RefundStatus;
  providerRefundRef: string | null; recordedByUserId: string | null; recordedAt: string | null; createdAt: string;
}
interface AdminPaymentDto {
  id: string; orderId: string; method: PaymentMethod; status: PaymentStatus;
  amount: string; collectedAmount: string; refundedAmount: string;
  providerOrderRef: string | null; providerTransactionRef: string | null; paidAt: string | null;
  refunds: RefundDto[];
  events: { id: string; eventType: string; signatureValid: boolean; processedAt: string | null; createdAt: string }[]; // no payload
  createdAt: string; updatedAt: string;
}
```

| Endpoint | idem | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /admin/payments/refunds` | – | whitelist `status` (`eq`), `reason` (`eq,in`), `createdAt` (`gte,lte`, sort, default `createdAt` ascending: oldest first, a work queue) | `200 RefundDto[]` + meta | – |
| `GET /admin/payments/:paymentId` | – | – | `200 AdminPaymentDto` | `PAYMENT_NOT_FOUND` 404 |
| `GET /admin/orders/:orderId/payment` | – | – | `200 AdminPaymentDto` | `PAYMENT_NOT_FOUND` 404 |
| `POST /admin/payments/refunds/:refundId/record` | required | `providerRefundRef str(1..100)` | `200 RefundDto` | `REFUND_NOT_FOUND` 404, `REFUND_ALREADY_RECORDED` 409 |

## 5. Events
Published: `payment.paid`, `payment.failed`, `payment.expired`, `payment.refund_recorded`.
Consumed: `seller_order.items_cancelled`, `seller_order.cancelled`, `seller_order.returned`, `seller_order.delivered`, `order.closed` (`payments.order-adjustments`).

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `INVALID_WEBHOOK_SIGNATURE` | 401 | Bad or missing signature |
| `PAYMENT_PROVIDER_UNAVAILABLE` | 502 | Kashier timeout / 5xx while creating a session |
| `PAYMENT_NOT_FOUND` | 404 | |
| `REFUND_NOT_FOUND` | 404 | |
| `REFUND_ALREADY_RECORDED` | 409 | |

## 7. Decisions (answered 2026-10-08, `00-overview.md` §9.1). No open questions.
- **S-4** Kashier failure webhooks are recorded only; the payment stays `initiated` until success or expiry.
- **S-12** COD status `cancelled` (applied to `02-database.md` v1.1, D-1).
