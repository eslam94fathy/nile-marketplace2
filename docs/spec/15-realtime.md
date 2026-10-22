# Spec 15 — realtime

Status: **v1.3 APPROVED (2026-10-21):** §9 RT-21 (R2-P6). **v1.2 APPROVED (2026-10-21):** §9 RT-20 (R2-P3). **v1.1 APPROVED (2026-10-20):** §9 R2-P2 implementation clarifications RT-8…RT-19 (every recommendation accepted). **v1.0 APPROVED (2026-10-20).** Changes from now on need explicit approval and a version bump. Release 2. Inputs: `00-overview.md` v2.0 §10.3 (realtime rules), R-4 (web client), R-5, R-21. §7 RT-1…RT-7 answered 2026-10-20 (every recommendation accepted).
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

The server tells connected clients that something they show has changed, over **Socket.IO** with the WebSocket transport only.
- The socket is a **notification channel, never a write path**. Every state change goes through the REST API, chat messages included.
- Messages carry ids and statuses, not full resources. The client refetches what it shows through REST, and always refetches after a reconnect.
- So a lost socket message loses no data. Delivery is at most once, with no replay buffer.

Tables: none.

Two parts:
1. **Gateway**: a new entrypoint `src/realtime.ts`, run as its own ECS service from the same image (RT-1). It handles the handshake, authentication, rooms and the few client → server signals (§3.3).
2. **Fan-out consumer** `realtime.fanout` in the **worker**. It maps domain events to client messages and publishes them through `@socket.io/redis-emitter`. The gateways share one Redis through `@socket.io/redis-adapter`, so any gateway task delivers to its own sockets.

Depends on (public APIs, read-only):
- `customers` / `sellers` / `delivery`: profile id from the user id, at connect
- `ordering`: parties and current status of orders and seller orders
- `support`: may this user view this ticket (spec 16)

Nothing depends on realtime. Other modules reach clients only by publishing domain events, or, for notifications, through the `lib/realtime` emitter (§2).

## 2. Public API

None as a module. The infrastructure piece is `lib/realtime`: an `IRealtimeEmitter` interface (`toRooms(rooms, message)`, `disconnectUser(userId)`) over the Redis emitter, so the worker can emit after a commit. Notifications uses it for `notification.created` (spec 13 v2.0). It is never called inside a DB transaction.

## 3. Use cases

### UC-RT-1 Connect (gateway)
1. The client connects to `wss://<api host>/realtime` (Socket.IO `path`) with `auth: { token: <access JWT> }`. The access token is the same one the web client keeps in memory (R-21). No cookie is read.
2. Request checks:
   - The `Origin` header must be in `CORS_ALLOWED_ORIGINS`, else refused. This guards against cross-site WebSocket hijacking.
   - The handshake rate limit, class `realtime-connect`, keyed by IP and, once the token is verified, by user id.
3. Verify the token with the existing `lib/auth` verifier: RS256 pinned, `iss`, `aud`, `exp`. Then check the suspended-user deny entry (I-11, fails open like `authenticate`). Failure → the connect error `UNAUTHENTICATED` (Socket.IO `connect_error` with `data.code`).
4. Resolve the profile id for the role and join the rooms:

| Role | Rooms |
|---|---|
| every user | `user:<userId>` |
| customer | `customer:<customerId>` |
| seller | `seller:<sellerId>` |
| delivery_agent | `agent:<agentId>` |
| admin | `admins` |

   A missing profile → connect error `FORBIDDEN` (as in conventions §3).
5. Schedule a disconnect at the token's `exp`, with reason `token_expired`. The client refreshes its token through REST and reconnects (RT-2).

### UC-RT-2 Fan out a domain event (worker consumer `realtime.fanout`)
1. Map the event to messages and target rooms (§3.1). Where a consumer needs parties or the current status, it **re-reads** them through the owning module's public API in one batched call, so out-of-order events still send the current status (`02-events.md` §1 rule).
2. Emit through the Redis emitter, with no DB transaction.
3. Failures:
   - Redis is down → `warn REALTIME_EMIT_FAILED`, ack. A late notification is worthless and the data is in the database (RT-3).
   - A public-API read fails → nack, normal retry.
4. No `processed_events` row. A duplicate delivery sends the same message twice, which is harmless because the client refetches. Every message carries `eventId`, so the client can drop duplicates.

### 3.1 Message catalogue (server → client)

Envelope (conventions v1.4 §9.3):
```ts
interface RealtimeMessage<T> { type: string; eventId: string; occurredAt: string; data: T }
```

| Message `type` | `data` | Rooms | From event |
|---|---|---|---|
| `order.updated` | `{ orderId, orderNumber, status }` | `customer:<id>` | `order.placed`, `order.closed`, `payment.paid` / `failed` / `expired` (ordering re-read) |
| `seller_order.placed` | `{ sellerOrderId, orderNumber }` | `seller:<id>` | `order.placed` (one per seller order) |
| `seller_order.updated` | `{ sellerOrderId, orderId, status }` | `customer:<id>`, `seller:<id>` | `seller_order.accepted` (new, spec 09 v2.0), `ready_for_pickup`, `items_cancelled`, `cancelled`, `returned`, `delivered` |
| `shipment.updated` | `{ shipmentId, sellerOrderId, orderId, status }` | `customer:<id>`, `agent:<id>` | `shipment.picked_up`, `out_for_delivery`, `attempt_failed`, `delivered` |
| `shipment.assigned` | `{ shipmentId, sellerOrderId }` | `agent:<new>`; `shipment.unassigned` to `agent:<previous>` | `shipment.assigned` |
| `payment.updated` | `{ orderId, paymentStatus }` | `customer:<id>` | `payment.paid`, `failed`, `expired`. The web client waits for this after the Kashier redirect, instead of polling (RT-4) |
| `media.updated` | `{ mediaId, status }` | `user:<uploader>` | `media.ready`, `media.failed` (spec 14) |
| `support.message_created` | `{ ticketId, messageId }` | `ticket:<id>`; also `user:<opener>` or `admins` (the other side) | `support.message_created` (spec 16). Internal notes go to `admins` only |
| `support.ticket_updated` | `{ ticketId, status, assignedAdminId }` | `ticket:<id>`, `user:<opener>`, `admins` | `support.ticket_*` (spec 16) |
| `support.typing` | `{ ticketId, userId, role }` | `ticket:<id>` except the sender | client signal (§3.3), never stored |
| `notification.created` | `{ notificationId, category, title, body, link }` | `user:<id>` | notifications, after it stores the in-app row (spec 13 v2.0) |

Messages carry no PII: no names, addresses, phone numbers or amounts. Statuses use the same enum values as the REST API. Type names live in an `as const` object (`RealtimeMessageType`).

### UC-RT-3 Suspension
`user.suspended` (new, identity, spec 03 v2.0) → `disconnectUser(userId)` (emitter `in('user:<id>').disconnectSockets()`). The deny entry then refuses any reconnect (UC-RT-1 step 3).

### 3.3 Client → server signals (gateway)
Only these are accepted. Anything else is ignored and logged at `debug`. Every payload is validated (DTO rules, conventions §1.1). The total inbound size is capped by `maxHttpBufferSize` (4 KB). A per-socket signal rate limit applies (RT-5).

| Signal | Payload | Effect | Ack |
|---|---|---|---|
| `ticket.subscribe` | `{ ticketId uuid }` | `support.canView(userId, role, ticketId)` (spec 16) → join `ticket:<id>` | `{ ok: true }` or `{ ok: false, code: 'SUPPORT_TICKET_NOT_FOUND' }` |
| `ticket.unsubscribe` | `{ ticketId uuid }` | Leave the room | `{ ok: true }` |
| `support.typing` | `{ ticketId uuid }` | Only in a joined `ticket:` room → relay §3.1 | none |

### UC-RT-4 Shutdown and deploys
On `SIGTERM` the gateway:
1. stops accepting handshakes;
2. disconnects its sockets with reason `server_shutting_down` (the Socket.IO client reconnects with randomised backoff to another task);
3. closes Redis and the DB pool;
4. exits within `SHUTDOWN_TIMEOUT_MS`.

`GET /health/live` and `GET /health/ready` (Redis + Postgres) are served by the gateway process itself.

## 4. Endpoints
No REST endpoints. Socket endpoint `wss://<host>/realtime` (§3). Its contract (messages, signals, connect errors) is documented in `docs/realtime.md`, generated next to the OpenAPI spec (RT-6).

## 5. Events
Published: none.
Consumed (queue `realtime.fanout`): `order.placed`, `order.closed`, `seller_order.accepted`, `seller_order.ready_for_pickup`, `seller_order.items_cancelled`, `seller_order.cancelled`, `seller_order.returned`, `seller_order.delivered`, `payment.paid`, `payment.failed`, `payment.expired`, `shipment.assigned`, `shipment.picked_up`, `shipment.out_for_delivery`, `shipment.attempt_failed`, `shipment.delivered`, `media.ready`, `media.failed`, `support.message_created`, `support.ticket_opened`, `support.ticket_assigned`, `support.ticket_status_changed`, `user.suspended`.

## 6. Error codes
Connect errors (`connect_error.data.code`): `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED`, `ORIGIN_NOT_ALLOWED`. Ack codes: `SUPPORT_TICKET_NOT_FOUND`, `VALIDATION_FAILED`, `RATE_LIMITED`, `INTERNAL_ERROR` (RT-20).
Disconnect reasons: `token_expired`, `server_shutting_down`, `account_suspended`.
Log event codes: `REALTIME_EMIT_FAILED` (warn).

Config (realtime process, own env schema, no defaults):
- `PORT`, `DATABASE_URL` + pool keys (a small pool), `REDIS_URL`
- the JWT verification keys, issuer and audience (the same values as the api)
- `CORS_ALLOWED_ORIGINS`, `TRUST_PROXY_HOPS`
- `RATE_LIMIT_REALTIME_CONNECT_POINTS` / `_DURATION_SECONDS`, `REALTIME_SIGNAL_RATE_PER_SECOND`
- `SHUTDOWN_TIMEOUT_MS`, `LOG_LEVEL`

The worker additionally needs `REDIS_URL` for the emitter. This reverses spec 06 CA-8, under which the worker had no Redis (architecture v2.0).

## 7. Decisions (answered 2026-10-20)

The user accepted every recommendation (2026-10-20). The table is kept for the reasoning; the answers are logged in `00-overview.md` §10.8.

| # | Topic | Options / recommendation |
|---|---|---|
| RT-1 | Where the gateway runs | **Rec:** its own entrypoint and ECS service behind the same ALB (path rule `/realtime*`, idle timeout 120 s); api deploys and autoscaling don't drop or skew sockets; 2 tasks of 0.25 vCPU to start · or inside the api process (one less service, but every api deploy drops every socket and long connections skew CPU autoscaling) |
| RT-2 | Token expiry on an open socket | **Rec:** disconnect at `exp`; the client refreshes through REST and reconnects (15 min access tokens → one reconnect per 15 min per tab) · or an `auth.renew` signal carrying a fresh token (no reconnect, more gateway code) |
| RT-3 | Fan-out when Redis is down | **Rec:** drop with a `warn` (best effort; data is in the DB) · or nack and retry (late, stale messages) |
| RT-4 | Kashier return page on the web | **Rec:** after the redirect, the client subscribes and waits for `payment.updated` (up to ~30 s), with a fallback `GET /orders/:id` poll every 5 s · or polling only |
| RT-5 | Inbound signal limits | **Rec:** 5 signals / s per socket; no per-user connection cap (handshake rate limit + 4 KB buffer); revisit after the R2-P8 socket load test · or a Redis-counted cap of N sockets per user |
| RT-6 | Socket contract docs | **Rec:** a hand-written `docs/realtime.md` (AsyncAPI is heavy for 12 messages), with message payload types exported from `src/app/realtime/messages.ts` and type-checked against it · or AsyncAPI 3 |
| RT-7 | Redis adapter flavour | **Rec:** the classic pub/sub `createAdapter` (single-shard ElastiCache, works with `@socket.io/redis-emitter`); compatibility verified in R2-P2 · or the sharded adapter (Redis 7 `SPUBLISH`; check emitter support first) |


## 8. Additions from specs 10, 17, 18 [2026-10-20]

| Message `type` | `data` | Rooms | From event |
|---|---|---|---|
| `return.updated` | `{ returnId, sellerOrderId, orderId, status }` | `customer:<id>`, `seller:<id>`; `admins` for `escalated` / `disputed` | `return.status_changed`, `return_shipment.*` (re-read status) |
| `shipment.updated` | as §3.1, plus `kind` | `agent:<id>` | `return_shipment.*` |
| `payment.updated` | as §3.1 | `customer:<id>` | `payment.refunded`, `payment.refund_recorded` |

No re-read for returns: `return.status_changed` carries the customer and seller ids, and the message uses the payload's `to` status. That is safe because the client refetches the return on every message.

## 9. Clarifications (R2-P2 implementation, approved 2026-10-20)

| # | Clarification | Where |
|---|---|---|
| RT-8 | The server tells the client why it closes a socket: a `session.ended { reason }` message just before the disconnect (Socket.IO only reports `io server disconnect`). For `account_suspended` it travels on another Redis channel than the disconnect, so it can be lost; the refused reconnect (`UNAUTHENTICATED`) says the same. The Socket.IO event name is the message `type`, and its argument is the whole envelope | UC-RT-1 step 5, UC-RT-3, UC-RT-4, §6 |
| RT-9 | `payment.updated.paymentStatus` and `shipment.updated.status` come from the event type (`shipment.attempt_failed` → `returning_to_seller` when `returningToSeller`, else `delivery_failed`). Realtime may read only ordering (architecture §14.2), and the client refetches on every message. The values are constants mirrored from the payments, delivery and media enums, kept equal by a test | §3.1 |
| RT-10 | R2-P2 ships what exists by then. Support's rooms, signals and messages come with spec 16 (R2-P3), `notification.created` with spec 13 (step 5), returns and refunds with their phases. Until then the gateway handles no signal: an unknown one is ignored (`debug` log), and the signal rate limit applies to all | §3.1, §3.3, §5 |
| RT-11 | A handshake **without** an `Origin` header is refused like a wrong one (`ORIGIN_NOT_ALLOWED`). Browsers always send it; a future native client will need its own decision | UC-RT-1 step 2 |
| RT-12 | The adapter and emitter channels are prefixed with `REDIS_KEY_PREFIX` (`<prefix>socket.io`), so environments (and test files) sharing a Redis never mix. The worker gets `REDIS_URL` and `REDIS_KEY_PREFIX`, with the same prefix as the gateway. Its Redis fails fast (no offline queue): a publish during an outage is dropped with `warn REALTIME_EMIT_FAILED` (RT-3). The emitter's own publish promise is caught (plan §2.3) | §2, §6 |
| RT-13 | Config: the rate keys are `RATE_LIMIT_REALTIME_CONNECT_POINTS` / `_WINDOW_SECONDS` (as every class, ME-8, not `_DURATION_SECONDS`); the limiter fails open. Staging and prod: 60 handshakes per 60 s per IP and per user, 5 signals / s. `PORT` 3001 in ECS and locally (`.env.realtime` next to `.env`, `docker compose` service `realtime`) | §6 |
| RT-14 | One domain event can give several messages with the same `eventId` (e.g. `order.updated` and `payment.updated`): clients drop duplicates by **`eventId` + `type`** | UC-RT-2 step 4, conventions §9.3 |
| RT-15 | The message catalogue (`RealtimeMessageType`, payload types, room names) lives in `src/lib/realtime/messages.ts`, not `src/app/realtime`: notifications emits `notification.created` too and may not import the realtime module (like the event contracts in `lib/events`) | RT-6 |
| RT-16 | Two more connect error codes: `SERVICE_UNAVAILABLE` (the task is shutting down; retry) and `INTERNAL_ERROR` (a profile lookup failed; retry with backoff, logged at `error`) | §6 |
| RT-17 | The fan-out runs on a **stateless** consumer kind of the consumer host: no transaction, no `processed_events` row, a throw retries as usual. A malformed payload or an unmapped event goes to the DLQ; an order the re-read can't find sends nothing (`warn`) | UC-RT-2 |
| RT-18 | `seller_order.placed` is not sent for a seller order still `pending_payment` (it is hidden from sellers, spec 09 §4.2). A Kashier order publishes `order.placed` when it is paid, so its sellers get it then | §3.1 |
| RT-19 | On shutdown the gateway waits up to 1 s for the `session.ended` frames to flush before it closes the server (closing at once dropped them) | UC-RT-4 |
| RT-20 | `ticket.subscribe` is acked `INTERNAL_ERROR` when the access check fails (database down); the client retries. Logged at `error` (v1.2) | §3.3, §6 |
| RT-21 | The §8 return and refund messages (`return.updated`, `shipment.updated` with `kind`, `payment.updated` from `payment.refunded` / `payment.refund_recorded`) ship in R2-P6 (spec 18 RE-17) (v1.3) | §8 |
