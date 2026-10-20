# Spec 16 — support

Status: **v1.0 DRAFT (2026-10-19).** Release 2. Inputs: `00-overview.md` v2.0 draft §10.4 (support tickets), R-8, R-9, R-19. §7 SU-1…SU-6 answered 2026-10-20 (every recommendation accepted).
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Support chat organised as **tickets**: a customer or a seller writes to the platform's admins.
- There is no customer ↔ seller chat. A seller never sees a customer's ticket, even when it is about their order (R-8, S-11); an admin relays what's needed.
- Messages are stored and sent through REST. The socket only tells the other side that something changed (spec 15).

Tables:
- `support_tickets`
- `support_messages`
- `support_message_attachments`: new against overview §10.2; one row per image (spec 14)
- `support_ticket_reads`

Depends on:
- `ordering`: who owns an order / seller order, and its number
- `customers`, `sellers`, `identity`: display names and emails for admin views; checking that an assignee is an active admin
- `media`: attachments

Enums:
- `TicketCategory`: `order, payment, delivery, return, account, seller_onboarding, other` (R-8). `seller_onboarding` is for sellers only.
- `TicketStatus`: `open` (no admin reply yet), `awaiting_admin`, `awaiting_user`, `resolved`, `closed`
- `TicketOpenerRole`: `customer, seller`
- `MessageKind`: `message, internal_note, system`. `system` covers auto-close, assignment and similar lines, written by the server.

Limits:
- **constants:** body 1..4000 characters; max 3 image attachments per message (R-9, purpose `support_attachment`, private media, spec 14 ME-1); subject 3..150.
- **env:** `SUPPORT_MAX_OPEN_TICKETS_PER_USER` (20, R-8; counts tickets neither `resolved` nor `closed`), `SUPPORT_SLA_HOURS` (24), `SUPPORT_AUTO_CLOSE_AFTER_HOURS` (168 = 7 days), `JOB_SUPPORT_INTERVAL_MS`, `SUPPORT_JOBS_BATCH_SIZE`.

### 1.1 Status machine
```
open ──admin message──► awaiting_user ──user message──► awaiting_admin ──admin message──► awaiting_user
open | awaiting_* ──admin resolve──► resolved ──user or admin message──► awaiting_admin | awaiting_user   (reopen)
resolved ──after SUPPORT_AUTO_CLOSE_AFTER_HOURS (job)──► closed
any but closed ──admin close──► closed            (spam, duplicates)
```
- A user message on `open` keeps it `open`.
- An **internal note** never changes the status and is allowed on any status, `closed` included.
- No message can be posted to a `closed` ticket (`409 SUPPORT_TICKET_CLOSED`); the user opens a new ticket.
- Every status change appends a `system` message (e.g. "Resolved by support"), so the history reads as one timeline.

### 1.2 Bookkeeping columns on `support_tickets`
- `ticket_number`: a human-friendly number, `T-` + a sequence, for phone and email references.
- `last_message_at`, `last_user_message_at` and `last_admin_message_at` (public messages only), all `TIMESTAMPTZ(3)`.
- `awaiting_admin_since`: set when the ticket enters `open` or `awaiting_admin`, cleared by an admin reply.
- `sla_breached_at`.

**Unread.** A ticket is unread for the opener when `last_admin_message_at > opener's last_read_at`. It is unread for an admin when `last_user_message_at > that admin's last_read_at`. One `support_ticket_reads` row per (ticket, user).

## 2. Public API (`index.ts`)

| Method | Caller | Notes |
|---|---|---|
| `canView(userId, role, ticketId) → boolean` | realtime (spec 15 `ticket.subscribe`) | The opener, or any admin |
| `getStats() → { open, awaitingAdmin, slaBreached }` | back-office dashboard (spec 20) | One aggregate query |

## 3. Use cases

### UC-SU-1 Open a ticket (customer or seller)
1. Validate the category for the role (`seller_onboarding` is seller-only) → `422 SUPPORT_CATEGORY_NOT_ALLOWED`.
2. Optional order link:
   - a customer may send `orderId`, optionally with one `sellerOrderId` of that order
   - a seller may send `sellerOrderId` only
   - ownership is checked through ordering; a missing or foreign order → `422 ORDER_NOT_FOUND` / `SELLER_ORDER_NOT_FOUND` (same answer for both, conventions §3)
3. One transaction:
   - Count the opener's tickets that are neither `resolved` nor `closed`. At or over the limit → `422 SUPPORT_OPEN_TICKET_LIMIT_REACHED`. This is a soft check without a lock: concurrent opens by one user are rare, the rate limit bounds them, and a small overshoot is accepted (SU-4).
   - Insert the ticket (`status = open`, `awaiting_admin_since = now()`) and its first message.
   - `media.claim(attachmentIds, { purpose: support_attachment, ownerUserId })`, then insert the attachment rows.
   - The opener's read row is set to now.
   - Outbox `support.ticket_opened` + `support.message_created`.

### UC-SU-2 Post a message
- **User** (opener only; anyone else → `404 SUPPORT_TICKET_NOT_FOUND`):
  - lock the ticket `FOR UPDATE`; `closed` → `409 SUPPORT_TICKET_CLOSED`
  - insert the message, claim its attachments, move the status (§1.1), update the bookkeeping columns
  - mark the ticket read for the sender
  - outbox `support.message_created`, plus `support.ticket_status_changed` when the status moved
- **Admin:** same steps, plus:
  - `internal: true` → `kind = internal_note`, no status or bookkeeping change, never shown to the user
  - a public admin message on an **unassigned** ticket assigns it to the sender in the same transaction (`support.ticket_assigned`) (SU-2)
- Lock order: ticket → media rows (inside `claim`).

### UC-SU-3 Assign, resolve, close (admin)
All three lock the ticket `FOR UPDATE`.
- **Assign:** `adminUserId` must be an active admin (identity) → `422 SUPPORT_ASSIGNEE_INVALID`; `null` unassigns. A `system` message + `support.ticket_assigned`.
- **Resolve:** from `open | awaiting_admin | awaiting_user` → `resolved`, `resolved_at`. Anything else → `409 SUPPORT_TICKET_INVALID_STATUS_TRANSITION`.
- **Close:** from any status except `closed` → `closed`, `closed_at`.
- Each writes a `system` message, `support.ticket_status_changed`, and an audit row (spec 20).

### UC-SU-4 Read state
`POST …/read` sets the caller's `last_read_at = now()` with an upsert. It only moves forward: `GREATEST(existing, now())`.

### UC-SU-5 Jobs (worker, advisory-locked, every `JOB_SUPPORT_INTERVAL_MS`)
Candidates are read without locks. Each ticket is then handled in its own short transaction with `FOR UPDATE SKIP LOCKED` (P5-Q5 pattern).
- **Auto-close:** `resolved` with `resolved_at < now() − SUPPORT_AUTO_CLOSE_AFTER_HOURS` → `closed` + `system` message + `support.ticket_status_changed` (actor `system`).
- **SLA flag:** `status IN (open, awaiting_admin)`, `awaiting_admin_since < now() − SUPPORT_SLA_HOURS`, and `sla_breached_at IS NULL` → set `sla_breached_at` + `warn SUPPORT_SLA_BREACHED`. The flag stays as history; the admin filter `slaBreached` shows tickets currently waiting with the flag set.

## 4. Endpoints

```ts
interface TicketSummaryDto {
  id: string; ticketNumber: string; category: TicketCategory; subject: string; status: TicketStatus;
  order: { id: string; orderNumber: string } | null; sellerOrderId: string | null;
  lastMessageAt: string; hasUnread: boolean; createdAt: string;
}
interface TicketMessageDto {
  id: string; kind: MessageKind;
  sender: { role: 'customer' | 'seller' | 'admin' | 'system'; isMe: boolean; displayName: string };
       // users see admins as "Nile Support" (SU-3); admins see the admin's name
  body: string;
  attachments: ImageDto[];          // presigned, private (spec 14 ME-1)
  createdAt: string;
}
interface AdminTicketSummaryDto extends TicketSummaryDto {
  opener: { userId: string; role: TicketOpenerRole; displayName: string; email: string };
  assignedAdmin: { userId: string; displayName: string } | null;
  slaBreachedAt: string | null; awaitingAdminSince: string | null;
}
```

Message lists: cursor on `createdAt, id`, default `-createdAt` (newest first; the client reverses). Users never receive `internal_note` rows.

### 4.1 Customer and seller   auth: customer | seller

| Endpoint | rate | idem | Body | Success | Errors |
|---|---|---|---|---|---|
| `POST /support/tickets` | `support-message` | required (SU-1) | `category enum` · `subject str(3..150)` · `body str(1..4000)` · `orderId opt uuid` (customer) · `sellerOrderId opt uuid` · `attachmentMediaIds opt uuid[]` `@ArrayMaxSize(3)` `@ArrayUnique` | `201 TicketSummaryDto` | `SUPPORT_CATEGORY_NOT_ALLOWED` 422, `ORDER_NOT_FOUND` 422, `SELLER_ORDER_NOT_FOUND` 422, `SUPPORT_OPEN_TICKET_LIMIT_REACHED` 422, `MEDIA_NOT_ATTACHABLE` 422 |
| `GET /support/tickets` | general | – | whitelist: `status` (enum, `eq,in`) · `category` (enum, `eq,in`) · `lastMessageAt` (sort, default `-lastMessageAt`) · `createdAt` (date, `gte,lte`, sort) | `200 TicketSummaryDto[]` + meta | – |
| `GET /support/tickets/:ticketId` | general | – | – | `200 TicketSummaryDto` | `SUPPORT_TICKET_NOT_FOUND` 404 |
| `GET /support/tickets/:ticketId/messages` | general | – | cursor, limit | `200 TicketMessageDto[]` + meta | `SUPPORT_TICKET_NOT_FOUND` |
| `POST /support/tickets/:ticketId/messages` | `support-message` | required | `body str(1..4000)` · `attachmentMediaIds opt uuid[]` (max 3) | `201 TicketMessageDto` | `SUPPORT_TICKET_NOT_FOUND`, `SUPPORT_TICKET_CLOSED` 409, `MEDIA_NOT_ATTACHABLE` |
| `POST /support/tickets/:ticketId/read` | general | – | – | `204` | `SUPPORT_TICKET_NOT_FOUND` |

`orderId` sent by a seller, or `sellerOrderId` without `orderId` by a customer → `400 VALIDATION_FAILED`. These are role-specific DTO rules.

### 4.2 Admin   auth: admin

| Endpoint | rate | idem | Body | Success | Errors |
|---|---|---|---|---|---|
| `GET /admin/support/tickets` | general | – | whitelist: `status` · `category` · `openerRole` (enum, `eq`) · `assignedAdminId` (uuid, `eq`) · `assigned` (bool, `eq`) · `slaBreached` (bool, `eq`) · `createdAt` · `lastMessageAt` (sort, default `-lastMessageAt`) · `awaitingAdminSince` (sort; the oldest-waiting queue) | `200 AdminTicketSummaryDto[]` + meta | – |
| `GET /admin/support/tickets/:ticketId` | general | – | – | `200 AdminTicketSummaryDto` | `SUPPORT_TICKET_NOT_FOUND` |
| `GET /admin/support/tickets/:ticketId/messages` | general | – | cursor, limit | `200 TicketMessageDto[]` (notes included) + meta | `SUPPORT_TICKET_NOT_FOUND` |
| `POST /admin/support/tickets/:ticketId/messages` | `support-message` | required | `body` · `attachmentMediaIds opt` · `internal bool` | `201 TicketMessageDto` | `SUPPORT_TICKET_NOT_FOUND`, `SUPPORT_TICKET_CLOSED` (public messages only), `MEDIA_NOT_ATTACHABLE` |
| `POST /admin/support/tickets/:ticketId/assign` | general | – | `adminUserId nullable uuid` | `200 AdminTicketSummaryDto` | `SUPPORT_TICKET_NOT_FOUND`, `SUPPORT_ASSIGNEE_INVALID` 422 |
| `POST /admin/support/tickets/:ticketId/resolve` | general | – | – | `200` | `SUPPORT_TICKET_NOT_FOUND`, `SUPPORT_TICKET_INVALID_STATUS_TRANSITION` 409 |
| `POST /admin/support/tickets/:ticketId/close` | general | – | – | `200` | same |
| `POST /admin/support/tickets/:ticketId/read` | general | – | – | `204` | `SUPPORT_TICKET_NOT_FOUND` |

`filter[assigned]` and `filter[assignedAdminId]` together → `400 INVALID_QUERY`.

## 5. Events
Published:
- `support.ticket_opened` `{ ticketId, ticketNumber, openerUserId, openerRole, category }`
- `support.message_created` `{ ticketId, messageId, kind, senderRole, openerUserId, assignedAdminUserId }`
- `support.ticket_assigned` `{ ticketId, openerUserId, assignedAdminUserId, previousAdminUserId }`
- `support.ticket_status_changed` `{ ticketId, openerUserId, from, to, actor }`

Consumed by realtime (spec 15) and notifications (spec 13 v2.0):
- push to the opener on a public admin message
- push to the assigned admin on a user message
- new tickets reach admins through the socket only, with no in-app rows (spec 13 NO-9)

Consumed: none.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `SUPPORT_TICKET_NOT_FOUND` | 404 | Missing, or not the caller's ticket |
| `SUPPORT_TICKET_CLOSED` | 409 | Message on a `closed` ticket |
| `SUPPORT_TICKET_INVALID_STATUS_TRANSITION` | 409 | Resolve or close not allowed from the current status |
| `SUPPORT_CATEGORY_NOT_ALLOWED` | 422 | `seller_onboarding` from a customer |
| `SUPPORT_OPEN_TICKET_LIMIT_REACHED` | 422 | Over `SUPPORT_MAX_OPEN_TICKETS_PER_USER` |
| `SUPPORT_ASSIGNEE_INVALID` | 422 | Not an active admin |
| `ORDER_NOT_FOUND`, `SELLER_ORDER_NOT_FOUND` | 422 | Owned by ordering; raised here for a foreign or missing link |

Log event codes: `SUPPORT_SLA_BREACHED` (warn).
New rate-limit class `support-message`: user id, `RATE_LIMIT_SUPPORT_MESSAGE_POINTS` / `_DURATION_SECONDS` (proposed 30 per minute).

## 7. Decisions (answered 2026-10-20)

The user accepted every recommendation (2026-10-20). The table is kept for the reasoning; the answers are logged in `00-overview.md` §10.8.

| # | Topic | Options / recommendation |
|---|---|---|
| SU-1 | Retried sends | **Rec:** the existing `Idempotency-Key` middleware (required) on ticket open and message post: tested code, replays the `201`, no extra columns. Overview §10.4 said "client message id", so this replaces it · or a `clientMessageId` column with a unique constraint |
| SU-2 | Auto-assign on first admin reply | **Rec:** yes, the replying admin takes an unassigned ticket · or replies never assign |
| SU-3 | How users see admins | **Rec:** every admin appears as "Nile Support" to users (no staff names exposed); admins see each other's names · or show the admin's first name |
| SU-4 | Open-ticket limit under concurrency | **Rec:** soft check, a small overshoot accepted (the rate limit bounds it) · or lock the opener's newest ticket / a per-user counter row |
| SU-5 | Audit of support actions (R-19 "every admin write") | **Rec:** assign, resolve and close are audited; admin messages and notes are not (the message table is already the record) · or audit messages too |
| SU-6 | Ticket retention | **Rec:** kept indefinitely (no deletion in R2); private attachments stay until the ticket is deleted in a later release · or delete closed tickets after N months |
