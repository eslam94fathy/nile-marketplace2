# Spec 13 — notifications (minimal)

Status: **DRAFT v0.1 (2026-10-08), under review.** [PROPOSED].
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Transactional email only (Q-14, Q-35) via **Mailjet**: email verification OTP, password reset OTP, account invite. No SMS, no push, no marketing.
Tables: `notification_log`.
Depends on: nothing. The recipient address and every template variable come in the event payload (architecture §2).
Runs only in the **worker**. It has no HTTP endpoints.

Config: `MAILJET_API_KEY`, `MAILJET_API_SECRET`, `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`, HTTP timeout.

## 2. Public API (`index.ts`)
None.

## 3. Use cases

### UC-NO-1 Send a transactional email (consumer `notifications.email` ← `notification.email_requested`)
1. `notification_log` already has `source_event_id = eventId` → ack, done (`uq_notification_log_source_event_id`).
2. Render the template (§3.1) and send through the `pkg/email` `IEmailSender` interface (Mailjet adapter, Send API v3.1).
3. Result:
   - Accepted by Mailjet → insert `notification_log` (`status = sent`, `provider_message_id`), ack.
   - **Permanent** failure (4xx: invalid address, rejected sender) → insert `status = failed` with a truncated `error`, `error` log `EMAIL_SEND_FAILED`, ack (retrying won't help).
   - **Transient** failure (timeout, 429, 5xx) → no log row, nack → the retry queue with backoff, then the DLQ (architecture §5).
4. The OTP / invite token is **never** written to `notification_log` or to logs.

A crash between "Mailjet accepted" and "log row committed" can send one duplicate email on redelivery. That's accepted (the OTP is the same value, and the newest one is the valid one).

### 3.1 Templates
Templates live **in the repo** (`src/app/notifications/templates/`), English only (SD-1), as HTML + plain-text pairs with a small typed renderer (no template engine dependency). They are versioned with the code and unit-tested. (The alternative, Mailjet-hosted templates referenced by id from env, lets non-developers edit copy but splits the source of truth: S-15.)

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

## 7. Open questions
- **S-1** Secrets in the outbox payload.
- **S-15** Templates in the repo vs. Mailjet-hosted.
