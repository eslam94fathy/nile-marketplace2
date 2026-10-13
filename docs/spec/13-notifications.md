# Spec 13 — notifications (minimal)

Status: **v1.1 APPROVED (2026-10-08).** Approved by the user. v1.1: Phase 1 implementation clarifications (§7.1, N-1…N-5). Changes from now on need explicit approval and a version bump.
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
