# Spec 13 — notifications (minimal)

Status: **v1.1 APPROVED (2026-10-08).** Approved by the user. v1.1: Phase 1 implementation clarifications (§7.1, N-1…N-5). Changes from now on need explicit approval and a version bump.
**v2.3 APPROVED (2026-10-21):** §8.12 support links NO-31 (R2-P3). **v2.2 APPROVED (2026-10-21):** §8.11 Web Push clarifications NO-22…NO-30 (every recommendation accepted). **v2.1 APPROVED (2026-10-20):** §8.10 R2-P2 implementation clarifications NO-12…NO-21 (every recommendation accepted). **v2.0 APPROVED (2026-10-20):** §8 adds Release 2 push (standard Web Push, R-20), the in-app notification centre and preferences (R-5…R-7). Kept as its own section, so every cross-reference stays valid (R2-Q1).
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Transactional email only (Q-14, Q-35) via **Mailjet**: email verification OTP, password reset OTP, account invite. No SMS, no push, no marketing.
Tables: `notification_log`.
Depends on: nothing. The recipient address and every template variable come in the event payload (architecture §2).
Runs only in the **worker**. It has no HTTP endpoints.

Config (worker only, P1-Q1): `EMAIL_PROVIDER` (`mailjet` | `mailpit`, P1-Q2), `MAILJET_API_KEY`, `MAILJET_SECRET_KEY`, `MAILJET_FROM_EMAIL`, `MAILJET_FROM_NAME`, `MAILPIT_URL` (when `mailpit`), HTTP timeout, `SECRETS_ENCRYPTION_KEYS` (decryption, S-1).

## 2. Public API (`index.ts`)
None.

## 3. Use cases

### UC-NO-1 Send a transactional email (consumer `notifications.email` ← `notification.email_requested`)
1. `notification_log` already has `source_event_id = eventId` → ack, done (`uq_notification_log_source_event_id`). The same check runs on `processed_events`.
   Validate the payload first: an unknown template, missing variables or an invite URL that isn't http(s) can never be sent → reject to the DLQ (N-3).
2. Decrypt `encryptedSecrets` with the key named in it (`02-events.md` §3.1, `SECRETS_ENCRYPTION_KEYS` from env). Failure → `error` log `SECRET_DECRYPT_FAILED` (no payload), reject to the DLQ.
   Render the template (§3.1) and send through the `pkg/email` `IEmailSender` interface (Mailjet adapter, Send API v3.1). Steps 1–2 run **outside** any DB transaction (N-1).
3. Result, recorded in one transaction together with the `processed_events` row:
   - Accepted by Mailjet → insert `notification_log` (`status = sent`, `provider_message_id`), ack.
   - **Permanent** failure (400 / 422: invalid address, rejected message) → insert `status = failed` with a truncated `error`, `error` log `EMAIL_SEND_FAILED`, ack (retrying won't help).
   - **Transient** failure (timeout, network, 429, 5xx, and 401 / 403, which mean our own credentials or sender setup are wrong and need a fix, not a dropped email) → no log row, nack → the retry queue with backoff, then the DLQ (architecture §5).
4. The OTP / invite token is **never** written to `notification_log` or to logs. Provider error text is redacted of every secret value before it is stored or logged (N-2).

A crash between "Mailjet accepted" and "log row committed" can send one duplicate email on redelivery. That's accepted (the OTP is the same value, and the newest one is the valid one).

### 3.1 Templates
Templates live **in the repo** (`src/app/notifications/templates/`), English only (SD-1), as HTML + plain-text pairs with a small typed renderer (no template engine dependency). They are versioned with the code and unit-tested. (S-15)

| Template | Variables | Subject |
|---|---|---|
| `email_verification` | `otp`, `expiresInMinutes` | "Your Nile verification code" |
| `password_reset` | `otp`, `expiresInMinutes` | "Reset your Nile password" |
| `account_invite` | `inviteUrl`, `role`, `expiresAt` | "You're invited to Nile" |

## 4. Endpoints
None.

## 5. Events
Published: none. Consumed: `notification.email_requested`.

## 6. Error codes
None exposed over HTTP. Log event codes: `EMAIL_SEND_FAILED`, `MQ_DEAD_LETTERED` (shared).

## 7. Decisions (answered 2026-10-08, `00-overview.md` §9.1). No open questions.
- **S-1** Secret variables arrive encrypted; this module decrypts them (UC-NO-1).
- **S-15** Templates live in the repo.

### 7.1 Implementation clarifications (v1.1, Phase 1, 2026-10-08)

| # | Clarification |
|---|---|
| N-1 | The provider call runs outside the DB transaction (CLAUDE.md §6.4) through the consumer host's `beforeTransaction` step (architecture §3.2, v1.2). The outcome is then recorded with the dedupe row in one transaction. The duplicate-on-crash case above still applies |
| N-2 | Provider error text is stripped of the OTP / invite URL before it reaches `notification_log.error` or a log line |
| N-3 | Malformed payloads (unknown template, missing or invalid variables, non-http(s) invite URL) are permanent errors → DLQ |
| N-4 | `notification_log`: `fk_notification_log_user_id … ON DELETE SET NULL` (the log outlives the user) and `chk_notification_log_error_on_failure` (a `failed` row always has an `error`), `02-database.md` v1.3 |
| N-5 | Failure classes (`pkg/email`): only 400 / 422 are permanent. 401 / 403 (credentials, unverified sender) are treated as transient, so the messages wait in retry / the DLQ for replay once the configuration is fixed |

---

## 8. Release 2: notification centre, preferences, Web Push [v2.0, approved 2026-10-20]

### 8.1 Scope and tables
Every user-facing domain event becomes:
1. an **in-app notification** row (the notification centre);
2. a socket message `notification.created` (spec 15);
3. a **browser push** through standard Web Push (VAPID, `web-push` library, R-20), unless the user muted that category for push (R-5, R-6).

Email stays as in §1–§7. Notifications gains HTTP endpoints, so it now runs in the api as well (endpoints) and in the worker (consumers, push sending).

New tables:
- `user_notifications`: `user_id` (FK `RESTRICT`; users are never deleted), `category`, `type`, `title VARCHAR(120)`, `body VARCHAR(300)`, `link VARCHAR(300)` (a client route such as `/orders/<id>`, never a full URL), `source_event_id`, `read_at` nullable, `created_at TIMESTAMPTZ(3)`. `uq_user_notifications_user_id_source_event_id` makes each event one row per recipient.
- `notification_preferences`: (`user_id`, `category`) PK, `push_enabled BOOLEAN`. A row exists only once the user changes a category. Without a row, the code default applies: on for `orders`, `shipments`, `support`; off for `promotions` (R-6). This is a code constant, not a DB default (G13 concerns stored business values).
- `push_subscriptions`: `user_id`, `endpoint VARCHAR(2048)` (unique), `p256dh VARCHAR(100)`, `auth VARCHAR(50)`, `user_agent VARCHAR(200)` nullable, `last_success_at` nullable, `created_at`. Max **10** per user (a constant); registering an 11th deletes the oldest.

Enums:
- `NotificationCategory`: `orders, shipments, support, promotions` (R-6). In-app rows are always created; preferences affect push only.
- `NotificationType`: one value per row of §8.2.

### 8.2 Event → notification mapping (consumer `notifications.user-events`)
Texts are English templates in the repo (S-15, SD-1). They contain no names, addresses or amounts (R-7). Where the recipient's user id isn't in the payload, it is resolved through the owning module's public API (customer / seller / agent → user id, batched).

| Event | Recipient | Category | Type | Text (title · body) |
|---|---|---|---|---|
| `order.placed` | customer | orders | `order_placed` | "Order placed" · "Order #{n} is confirmed." |
| `order.placed` | each seller of the checkout | orders | `seller_order_received` | "New order" · "Order #{n} is waiting for you to accept it." |
| `seller_order.accepted` | customer | orders | `seller_order_accepted` | "Order accepted" · "Part of order #{n} was accepted." (whole order if one seller) |
| `seller_order.cancelled` | customer (any reason); seller (when not cancelled by the seller) | orders | `seller_order_cancelled` | "Order cancelled" · "Part of order #{n} was cancelled." |
| `payment.failed`, `payment.expired` | customer | orders | `payment_failed` | "Payment not completed" · "Order #{n} was not paid." |
| `shipment.assigned` | new agent | shipments | `shipment_assigned` | "New pickup" · "A new shipment is assigned to you." |
| `shipment.out_for_delivery` | customer | shipments | `out_for_delivery` | "On the way" · "Order #{n} is out for delivery." |
| `shipment.attempt_failed` | customer | shipments | `delivery_attempt_failed` | "Delivery attempt failed" · "We couldn't deliver order #{n}." |
| `seller_order.delivered` | customer | shipments | `delivered` | "Delivered" · "Order #{n} was delivered." |
| `support.message_created` (public admin message) | opener | support | `support_reply` | "New reply" · "Support replied on {ticketNumber}." |
| `support.message_created` (user message, assigned ticket) | assigned admin | support | `support_user_message` | "New message" · "{ticketNumber} has a new message." |
| `support.ticket_status_changed` → `resolved` | opener | support | `support_resolved` | "Ticket resolved" · "{ticketNumber} was marked resolved." |

Release 2 phases R2-P4…P7 add rows for reviews, returns and refunds in their own specs. `promotions` has no automatic sender in R2 (NO-11).

### 8.3 Use cases

#### UC-NO-2 Store and announce (consumer `notifications.user-events`)
1. Map the event (§8.2) and resolve the recipients (one batched call).
2. One transaction:
   - insert the rows (`ON CONFLICT (user_id, source_event_id) DO NOTHING`) and `processed_events`;
   - for each **new** row whose category the recipient hasn't muted for push, write an outbox `notification.push_requested { notificationId, userId }` (NO-6).
3. After commit: emit `notification.created` to `user:<id>` (spec 15; best effort).

#### UC-NO-3 Send a push (consumer `notifications.push` ← `notification.push_requested`)
1. Load the notification and the user's subscriptions. If there are none, or the preference was muted since, ack.
2. Outside the transaction (`beforeTransaction`, N-1), send to each subscription. The payload is encrypted per RFC 8291 by `web-push` and is `{ notificationId, title, body, link, category }`, with Web Push `TTL` 24 h and urgency `normal` (`high` for `shipment_assigned`).
3. Results per subscription:
   - `201` → `last_success_at`
   - `404` / `410` → delete the subscription
   - `400` / `413` → permanent, `warn PUSH_SEND_FAILED`
   - timeout / `429` / `5xx` → transient
4. If every subscription failed transiently → nack (retry with backoff, then DLQ). If some succeeded → `warn` and ack, so the devices that got it don't get a duplicate.
5. Record `push_sent_at` on the notification in one transaction with the dedupe row.

#### UC-NO-4 Subscriptions and session hygiene
- **Register:** the endpoint must be `https` and its host must match `PUSH_ENDPOINT_HOST_ALLOWLIST` (FCM, Mozilla, Windows, Apple push services) → else `422 PUSH_ENDPOINT_NOT_ALLOWED`. This guards against SSRF: the worker sends HTTP requests to this URL. Upsert by endpoint: a browser that switches accounts moves its subscription to the new user.
- **Unregister:** the client calls it before logout.
- `user.suspended` and `user.sessions_revoked` (new identity events on password reset, spec 03 v2.0) → delete all of the user's subscriptions, so a logged-out or lost device stops showing lock-screen texts (NO-8).

#### UC-NO-5 Retention job (worker)
Deletes `user_notifications` older than `NOTIFICATION_RETENTION_DAYS` (90, NO-7) in batches.

### 8.4 Endpoints   auth: customer | seller | admin | delivery_agent · rate: general

```ts
interface UserNotificationDto {
  id: string; category: NotificationCategory; type: NotificationType;
  title: string; body: string; link: string | null; read: boolean; createdAt: string;
}
```

| Endpoint | Body / query | Success | Errors |
|---|---|---|---|
| `GET /me/notifications` | whitelist `read` (bool, `eq`) · `category` (enum, `eq,in`) · `createdAt` (sort only, default `-createdAt`) | `200 UserNotificationDto[]` + meta | – |
| `GET /me/notifications/unread-count` | – | `200 { count }` (capped at 100) | – |
| `POST /me/notifications/:notificationId/read` | – | `204` | `NOTIFICATION_NOT_FOUND` 404 |
| `POST /me/notifications/read-all` | – | `204` | – |
| `GET /me/notification-preferences` | – | `200 { category, pushEnabled }[]` (all four, defaults filled in) | – |
| `PUT /me/notification-preferences` | `preferences: { category enum, pushEnabled bool }[]` `@ArrayMaxSize(4)`, unique categories | `200` same as GET | – |
| `GET /push/config` | – | `200 { vapidPublicKey }` | – |
| `POST /me/push-subscriptions` | `endpoint str(1..2048)` (https URL) · `keys: { p256dh str(1..100) base64url, auth str(1..50) base64url }` · `userAgent opt str(1..200)` | `201` (also on an upsert) | `PUSH_ENDPOINT_NOT_ALLOWED` 422 |
| `POST /me/push-subscriptions/unregister` | `endpoint str(1..2048)` | `204` (also when unknown) | – |

### 8.5 Events
Published: `notification.push_requested` (internal, queue `notifications.push`).
Consumed: §8.2 events (queue `notifications.user-events`), `notification.push_requested`, `user.suspended`, `user.sessions_revoked`.

### 8.6 Error codes and config
- Error codes: `NOTIFICATION_NOT_FOUND` (404), `PUSH_ENDPOINT_NOT_ALLOWED` (422). Log codes: `PUSH_SEND_FAILED` (warn).
- Config, no defaults:
  - **api:** `VAPID_PUBLIC_KEY`, `PUSH_ENDPOINT_HOST_ALLOWLIST`.
  - **worker:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (secret), `VAPID_SUBJECT` (`mailto:`), `PUSH_HTTP_TIMEOUT_MS`, `PUSH_ENDPOINT_HOST_ALLOWLIST` (re-checked before sending), `NOTIFICATION_RETENTION_DAYS`, `JOB_NOTIFICATION_RETENTION_INTERVAL_MS`.
  - Rotating the VAPID keys invalidates every subscription; the runbook covers it.

### 8.7 Decisions (answered 2026-10-20)

The user accepted every recommendation (2026-10-20). The table is kept for the reasoning; the answers are logged in `00-overview.md` §10.8.

| # | Topic | Options / recommendation |
|---|---|---|
| NO-6 | Push delivery path | **Rec:** a second outbox event + queue `notifications.push` (retries, DLQ, as for email) · or send right after commit, best effort (a transient failure loses the push; the in-app row stays) |
| NO-7 | In-app retention | **Rec:** 90 days · or keep forever |
| NO-8 | Subscriptions after a password reset or suspension | **Rec:** delete all of the user's subscriptions (new identity events `user.suspended`, `user.sessions_revoked`); change-password keeps them (the current device stays signed in) · or keep them until the browser drops them |
| NO-9 | Admin notifications | **Rec:** new tickets reach admins through the socket (`admins` room) only; an assigned admin gets in-app + push for user messages; no rows fanned out to every admin · or an in-app row for every admin per new ticket |
| NO-10 | Delivery agents | **Rec:** agents use the same web app and get `shipment_assigned` with `high` urgency · or no push for agents in R2 |
| NO-11 | `promotions` category | **Rec:** created now (preferences exist, off by default) with no sender in R2; campaign sending is a later release · or leave the category out until there is a sender |

### 8.8 Additions from specs 17 and 20 [2026-10-20]
Rows added to the §8.2 mapping (RV-8 and BO-8 accepted 2026-10-20):

| Event | Recipient | Category | Type | Text (title · body) |
|---|---|---|---|---|
| `review.created` | the seller | orders | `review_received` | "New review" · "One of your products has a new review." |
| `review.replied` | the reviewer | orders | `review_replied` | "Seller replied" · "The seller replied to your review." |
| `product.blocked` | the seller | orders | `product_blocked` | "Product blocked" · "A product was blocked by the platform." |
| `seller_order.cancelled` (`admin_cancelled`) | customer and seller | orders | `seller_order_cancelled` | unchanged §8.2 row; the seller now also receives it because an admin, not the seller, cancelled |

### 8.9 Additions from specs 10 and 18 [2026-10-20]
RE-9 and PA-26 accepted 2026-10-20. All under `orders`:

| Event | Recipient | Type | Text (title · body) |
|---|---|---|---|
| `return.status_changed` → `requested` | seller | `return_requested` | "Return requested" · "A return was requested on order #{n}." |
| → `approved` | customer | `return_approved` | "Return approved" · "Your return {returnNumber} was approved. An agent will pick it up." |
| → `rejected` | customer | `return_rejected` | "Return rejected" · "Your return {returnNumber} was rejected. You can escalate it." |
| → `picked_up` | customer | `return_picked_up` | "Return picked up" · "Your return {returnNumber} is on its way to the seller." |
| → `received` | seller | `return_received` | "Return arrived" · "Return {returnNumber} was delivered to you. Please inspect it." |
| → `completed` | customer | `return_completed` | "Return accepted" · "Return {returnNumber} is complete. Your refund is on its way." |
| → `refused` | customer, seller | `return_refused` | "Return closed" · "Return {returnNumber} was closed without a refund." |
| `payment.refunded`, `payment.refund_recorded` | customer | `refund_issued` | "Refund issued" · "Your refund for order #{n} was issued." |

### 8.10 Clarifications (R2-P2 implementation, approved 2026-10-20)

| # | Clarification | Where |
|---|---|---|
| NO-12 | `link` values are client routes the web app provides: the customer `/orders/<orderId>`, the seller `/seller/orders/<sellerOrderId>`, the agent `/agent/shipments/<shipmentId>` | §8.1, §8.2 |
| NO-13 | "Part of order #{n}" only when the order has several seller orders, else "Order #{n}": for `seller_order_accepted` and the customer's `seller_order_cancelled`. The seller's cancellation reads "Order #{n} was cancelled." (its own seller order) | §8.2 |
| NO-14 | Who is told what. `order.placed`: a seller row only for seller orders not `pending_payment`. `seller_order.cancelled`: no customer row for `payment_failed` / `payment_expired` (they already get `payment_failed`), and no seller row when the seller cancelled or the seller order was still `pending_payment` (the seller never saw it) | §8.2 |
| NO-15 | The retention job deletes in batches of `NOTIFICATION_RETENTION_BATCH_SIZE` (worker env, like audit). Staging and prod: 90 days, daily, 1 000 per batch | UC-NO-5, §8.6 |
| NO-16 | The type CHECK and enum list every §8.2, §8.8 and §8.9 type now, so the later phases add senders, not CHECK changes | §8.1 |
| NO-17 | `read`: an already-read notification stays as it was (`204`); another user's or an unknown id is `404 NOTIFICATION_NOT_FOUND`. `read-all` touches only unread rows | §8.4 |
| NO-18 | `PUT /me/notification-preferences` changes only the categories it lists (1…4, each once; else `400`) and answers all four | §8.4 |
| NO-19 | Recipients are resolved before the transaction (the consumer host's `beforeTransaction`, P1-I4): ordering's parties (`getNotificationParties`) and the profile → user id lookups. An order that can't be found, or a profile without a user, is skipped with a `warn` | UC-NO-2 step 1 |
| NO-20 | The push request and the `notification.created` message go only for rows this delivery inserted, so a redelivered event announces nothing. The message carries the source `eventId` and the row's `created_at` | UC-NO-2 steps 2–3 |
| NO-21 | Step split inside R2-P2: the centre and preferences ship in step 5; subscriptions, sending, the VAPID config and the `user.suspended` / `user.sessions_revoked` clean-up in step 6, in the same PR. Until the `notifications.push` queue exists, a published `notification.push_requested` has no queue and is dropped | §8.3 |

### 8.11 Clarifications (R2-P2 Web Push, approved 2026-10-21)

| # | Clarification | Where |
|---|---|---|
| NO-22 | `PUSH_ENDPOINT_HOST_ALLOWLIST` entries are an exact host or `*.` + a domain (its subdomains only). An endpoint must be `https` on the default port, without credentials. Value in every environment: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`, `web.push.apple.com`. The worker re-checks each stored subscription before sending; one no longer allowed is deleted with a `warn` | UC-NO-4, §8.6 |
| NO-23 | The register body is `PushSubscription.toJSON()` as the browser gives it: its `expirationTime` (number or null) is accepted and ignored; the keys are base64url. The answer is `201` with an empty object | §8.4 |
| NO-24 | "At most 10 per user" holds under parallel registrations: they are serialised by a transaction-scoped advisory lock on the user id (notifications may not lock identity's `users` row, and a first subscription has no row of its own). Unregistering another user's endpoint changes nothing (`204`) | §8.1, UC-NO-4 |
| NO-25 | Send outcomes: `403` (e.g. after a VAPID key change) counts like `400` / `413`: permanent, `warn PUSH_SEND_FAILED`, the subscription is kept (the browser replaces it when it resubscribes). The timeout `PUSH_HTTP_TIMEOUT_MS` covers the whole request. When no device got it (all gone or rejected), the message is acked and `push_sent_at` stays null | UC-NO-3 steps 3–5 |
| NO-26 | A request whose notification is gone (retention), or whose category the user muted since, is acked without sending | UC-NO-3 step 1 |
| NO-27 | `user.suspended` and `user.sessions_revoked` are handled on `notifications.user-events` (as spec 02 §6.1 lists), deleting the user's subscriptions in the dedupe transaction | UC-NO-4, §8.5 |
| NO-28 | `GET /push/config` needs a token like every §8.4 endpoint (the web app asks for it after login) | §8.4 |
| NO-29 | Terraform: `vapid_public_key` and `vapid_subject` (`mailto:` the ops address) are tfvars; `VAPID_PRIVATE_KEY` is a secret filled by hand. `docs/runbooks/secrets.md` covers generating the pair and its rotation, which drops every subscription (R2-Q7) | §8.6 |
| NO-30 | The sender is `pkg/push` (`IPushSender`, a `web-push` adapter), so FCM can replace it later behind the same interface (R-20) | §8.1 |

### 8.12 Clarifications (R2-P3 support, approved 2026-10-21)

| # | Clarification | Where |
|---|---|---|
| NO-31 | Support links: `support_reply` and `support_resolved` (opener) `/support/tickets/<ticketId>`; `support_user_message` (assigned admin) `/admin/support/tickets/<ticketId>`. The recipients come from the event payload (`openerUserId`, `assignedAdminUserId`), so no lookup is needed (spec 16 SU-14) | §8.2 |
