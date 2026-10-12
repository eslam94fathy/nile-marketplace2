# Spec 10 — payments

Status: **v1.2 APPROVED (2026-10-12).** v1.0: approved by the user with the Phase 5 clarifications in §7.1. v1.1: what Kashier's test environment showed (PA-11…PA-17: no abandon, one open session per order, status mapping, config). v1.2: the worker holds no Kashier secret (PA-18); the webhook answers in the standard envelope (PA-19). Changes from now on need explicit approval and a version bump.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

One payment per checkout (Q-9): COD and Kashier. Kashier sessions, the signed webhook, payment expiry (called by ordering's job), COD collection tracking, refund flags and admin recording of manual refunds (R1 refunds are done by hand in the Kashier dashboard).
Tables: `payments`, `payment_refunds`, `payment_events`.
Depends on: nothing (it calls Kashier over HTTP through a `pkg/payments` gateway interface, never inside a DB transaction).

Enums:
- `PaymentStatus` COD: `pending, partially_collected, collected, cancelled` (`cancelled` is new, S-12) · Kashier: `initiated, paid, failed, expired, partially_refunded_manually, refunded_manually`
- `RefundReason`: `seller_order_cancelled, items_cancelled, delivery_failed, late_payment_after_expiry, all_cancelled_fee, amount_mismatch` (`amount_mismatch` is new, PA-6) · `RefundStatus`: `pending_manual, recorded`

Config (PA-1, PA-5, PA-9, PA-14): `PAYMENT_GATEWAY` (`kashier|fake`), `KASHIER_MERCHANT_ID`, `KASHIER_API_KEY` (the `api-key` header **and** the webhook HMAC key), `KASHIER_SECRET_KEY` (the `Authorization` header; single-quoted in `.env`, it can contain `$`, PA-16), `KASHIER_BASE_URL`, `KASHIER_MODE` (`test|live`, a startup guard: `live` only with the live host), `KASHIER_REDIRECT_URL` (https app link, PA-8), `KASHIER_WEBHOOK_URL` (sent per session as `serverWebhook`), `KASHIER_HTTP_TIMEOUT_MS`. The session `paymentType` is the constant `credit` (PA-14).

> Kashier integration (PA-1): v3 **payment sessions** (create with `expireAt`, amount, EGP, the order id = `merchantOrderId`, `serverWebhook`; the response carries `_id` and `sessionUrl`) and **get session by id** (status). Kashier allows **one open or paid session per `order`**, also for parallel requests (PA-12). Field names were verified against Kashier's OpenAPI document and its test environment (2026-10-12). This spec fixes **our** behaviour; the gateway adapter maps it to Kashier's API.

## 2. Public API (`index.ts`)

| Method | Caller | Behaviour |
|---|---|---|
| `createForOrder({ orderId, method, amount }, trx)` | ordering (checkout) | COD → `pending`, Kashier → `initiated`. `collected_amount = 0`, `refunded_amount = 0` |
| `createKashierSession(orderId, expiresAt) → { checkoutUrl, expiresAt }` | ordering | **Outside a transaction.** Returns the stored session while `provider_session_expires_at > now()`. Otherwise calls Kashier with `merchantOrderId = payments.id`, amount, EGP, `expireAt = expiresAt`, and stores `provider_order_ref`, `provider_session_url`, `provider_session_expires_at` with a conditional update. Kashier refuses a second open session for the same payment, so the loser of a race reads back the stored session (PA-12). Throws `PAYMENT_PROVIDER_UNAVAILABLE` on timeout/5xx, and when Kashier holds an open session we never stored (`error` log `KASHIER_SESSION_LOST`, PA-12) |
| `fetchProviderStatus(orderId) → 'paid' \| 'pending' \| 'unpaid' \| 'unknown'` | ordering (expiry job) | Outside a transaction. Kashier get session by id (no credential, PA-13); status mapping in PA-13; no session stored → `unpaid`; timeout/5xx → `unknown` |
| `markPaidFromProvider(orderId, providerData)` | ordering (expiry job) | Same effect as a success webhook (UC-PA-2) |
| `expire(orderId, trx) → boolean` | ordering (expiry job) | Conditional `initiated → expired`. `false` = it wasn't `initiated` any more (the webhook won). Outbox `payment.expired` |
| `getSummaries(orderIds) → { orderId, method, status, amount, collectedAmount, refundedAmount }[]` | ordering (order views) | Batched |

## 3. Use cases

### UC-PA-1 Kashier webhook (architecture §7.2)
1. Parse the **raw body** and verify `x-kashier-signature`: an HMAC-SHA256 keyed by `KASHIER_API_KEY` over the values of the alphabetically sorted `data.signatureKeys` (constant-time compare; `data.hash` is ignored) (PA-1). Invalid or missing → `401 INVALID_WEBHOOK_SIGNATURE`, `warn` log without the payload, nothing stored (PA-7).
2. Insert `payment_events` (payload with card data stripped; `provider_event_id` = `<event>:<data.transactionId>`, stable across Kashier's retries, PA-15). `uq_payment_events_provider_provider_event_id` duplicate → `200`, done.
3. Find the payment by `merchantOrderId` (= `payments.id`). Unknown → `error` log `KASHIER_UNKNOWN_ORDER`, `200` (so Kashier stops retrying).
4. By event outcome (read from `data.status`, never from `event` alone, PA-1):
   - **Success:** amount ≠ `payments.amount` → `failed`, `collected_amount` = the paid amount, a `payment_refunds` row for it (`amount_mismatch`, `pending_manual`), `error` log `PAYMENT_AMOUNT_MISMATCH`, outbox `payment.failed (amount_mismatch)` (PA-6). Otherwise UC-PA-2.
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
`200 { "success": true, "data": { "received": true } }` (the standard envelope, PA-19). Errors: `INVALID_WEBHOOK_SIGNATURE` 401.

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

### 7.1 Clarifications (v1.0, Phase 5 plan, 2026-10-12)

| # | Clarification | Where |
|---|---|---|
| PA-1 | Kashier integration: v3 payment sessions (with `expireAt` and a per-session `serverWebhook`), get session for `fetchProviderStatus`, abandon session. Webhooks are signed in `x-kashier-signature` with an HMAC over the sorted `data.signatureKeys` values, keyed by the payment API key (`KASHIER_API_KEY`; `KASHIER_SECRET_KEY` is only the `Authorization` header); success is read from `data.status`. `provider_event_id` = Kashier's own id if present, else `<event>:<transactionId>:<status>`. All verified against Kashier's test environment before the Kashier PR merges; needs a Kashier test account (P5-Q8) | §1, §2, UC-PA-1 |
| PA-2 | Lock order (spec 09 OR-3): `payments` is locked last. The webhook never locks `orders`; ordering's expiry job calls `expire` after it has locked the order, its seller orders and released stock (P5-Q3) | §2, UC-PA-1 |
| PA-3 | One Kashier session per payment: the session is stored in `provider_order_ref`, `provider_session_url`, `provider_session_expires_at` (database D-8) with `UPDATE … WHERE id = ? AND status = 'initiated' AND provider_order_ref IS NULL`; the loser of a race abandons its own session (P5-Q7) | §2 |
| PA-4 | The expiry job abandons the session before expiring (best effort) and skips payments that are already `paid` locally (spec 09 OR-6); a payment that still succeeds is SD-5 (UC-PA-2) (P5-Q6) | §2 |
| PA-5 | Gateway behind `pkg/payments` `IPaymentGateway`; `PAYMENT_GATEWAY` `kashier` / `fake` (no default; `fake` refused in staging/production). The fake keeps sessions in memory and a dev-only `npm run dev:kashier-webhook` sends correctly signed webhooks, so the real verification path runs locally and in tests (P5-Q9) | §1 |
| PA-6 | Amount mismatch on a successful payment: the payment is `failed`, `collected_amount` = the paid amount, and a full refund is flagged with the new `RefundReason` `amount_mismatch`, so it shows in the refund queue; recording it moves the payment to `refunded_manually` as in UC-PA-4 (P5-Q11 b) | UC-PA-1 |
| PA-7 | A webhook with an invalid signature stores nothing, so `payment_events.signature_valid` is always `true` in R1; the column stays (P5-Q11 a) | UC-PA-1 |
| PA-8 | `KASHIER_REDIRECT_URL` is an https app link agreed with the mobile team before staging (spec 09 OR-11) (P5-Q14) | §1 |
| PA-9 | Env split (P1-Q1): api `PAYMENT_GATEWAY` + every `KASHIER_*`; worker `PAYMENT_GATEWAY` + `KASHIER_*` without `KASHIER_REDIRECT_URL` and `KASHIER_WEBHOOK_URL` (it only reads and abandons sessions). No defaults (P5-Q10) | §1 |
| PA-10 | The `payments.order-adjustments` consumer, COD collection included, is built in Phase 5 and tested by publishing the contract events (P5-Q2) | UC-PA-3 |
| PA-11 | No session abandon (K-1, supersedes the abandon parts of PA-3 and PA-4): Kashier's documented abandon call (`PATCH /v3/payment/sessions/{id}`, no credential) answered 404 in every form on the test environment, and it isn't needed: a session is created with `expireAt` = `payment_expires_at`, so Kashier stops accepting payment when our window closes, and PA-12 rules out a second session. A payment that still succeeds after expiry is SD-5 (UC-PA-2) | §2, PA-3, PA-4 |
| PA-12 | Session `order` = `payments.id`. Kashier refuses a second session for an `order` that has an open or paid one ("another session is opened or paid"), verified for sequential and parallel calls. On that refusal `createKashierSession` returns the stored session; if none is stored (our first call timed out after Kashier created it) it throws `PAYMENT_PROVIDER_UNAVAILABLE` with an `error` log `KASHIER_SESSION_LOST`, and the order expires as usual. A payment on that session still arrives by webhook, keyed by `merchantOrderId` (K-2) | §2 |
| PA-13 | Provider status = `GET /v3/payment/sessions/{id}` (no credential, so not behind Kashier's IP allow-list). `PAID`, `AUTHORIZED`, `REFUNDED`, `PARTIALLY_REFUNDED`, `REFUND_PENDING` → `paid`; `PENDING` (an attempt in flight) → `pending`: the expiry job leaves the order for its next run; every other status → `unpaid`; timeout / 5xx → `unknown` (expire anyway, SD-5) (K-3) | §2, spec 09 §3.10 |
| PA-14 | No `KASHIER_PAYMENT_TYPE` or `KASHIER_FEP_BASE_URL` env keys: `paymentType` is the constant `credit`, and the payment page URL comes back whole in `sessionUrl`. `KASHIER_MODE` is a startup guard (`live` requires the live host, `test` the test host) (K-4) | §1 |
| PA-15 | Webhook dedupe id `provider_event_id` = `<event>:<data.transactionId>` (K-5) | UC-PA-1 |
| PA-16 | `KASHIER_SECRET_KEY` can contain `$`: it is single-quoted in `.env` so neither Node nor docker compose expands it; `.env.example` says so (K-6) | §1 |
| PA-17 | Kashier checks secret-key calls against an IP allow-list: the staging and production egress IPs must be allow-listed (or the list kept empty) before staging; open item for Phase 8 (K-7) | §1 |
| PA-18 | Supersedes PA-9 for the worker: it only reads session statuses (PA-13, no credential), so its env has `PAYMENT_GATEWAY`, `KASHIER_API_KEY`, `KASHIER_HTTP_TIMEOUT_MS`, `KASHIER_BASE_URL` and `KASHIER_MODE` only: never the secret key, merchant id, redirect or webhook URL (Phase 5 step 10, v1.2) | §1 |
| PA-19 | The webhook answers `200` in the standard success envelope (CLAUDE.md §7); Kashier only reads the status code (Phase 5 step 10, v1.2) | §4.1 |
