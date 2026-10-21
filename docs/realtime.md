# Realtime socket contract

The web client's live channel (spec 15). Hand-written (RT-6). The message types and payloads are the TypeScript types in `src/lib/realtime/messages.ts`; this page follows them.

The socket **only notifies**. Every read and write goes through the REST API. A message says *what changed*, by id and status. The client then refetches what it shows. A lost message loses no data: delivery is at most once, with no replay. **After every reconnect, refetch.**

## Connecting

| | |
|---|---|
| URL | `wss://api.<domain>` with Socket.IO `path: '/realtime'` (locally `ws://localhost:3001`) |
| Transport | `transports: ['websocket']` only (no long polling) |
| Auth | `auth: { token: <access JWT> }`, the same access token the client sends as `Bearer`. No cookie is read |
| Origin | The browser's `Origin` must be one of `CORS_ALLOWED_ORIGINS` |

```ts
import { io } from 'socket.io-client';

const socket = io('https://api.example.com', {
  path: '/realtime',
  transports: ['websocket'],
  auth: (cb) => cb({ token: currentAccessToken() }), // read at every (re)connect
});
```

On connect the server puts the socket in its rooms: `user:<userId>`, plus one for the role (`customer:<customerId>`, `seller:<sellerId>`, `agent:<agentId>` or `admins`). The only room a client asks for is a support ticket's, with `ticket.subscribe` (see Signals).

### Connect errors

Socket.IO's `connect_error` carries `error.data.code`:

| Code | Meaning | Client action |
|---|---|---|
| `ORIGIN_NOT_ALLOWED` | `Origin` missing or not allowed | Configuration error; don't retry |
| `UNAUTHENTICATED` | Token missing, invalid or expired, or the account is suspended | Refresh the token through REST (`POST /auth/refresh`), then reconnect. If the refresh fails, log out |
| `FORBIDDEN` | The account has no profile for its role | Don't retry |
| `RATE_LIMITED` | Too many handshakes from this IP or user | Back off, then retry |
| `SERVICE_UNAVAILABLE` | The task is shutting down | Retry (another task answers) |
| `INTERNAL_ERROR` | A server-side lookup failed | Retry with backoff |

### When the server closes the socket

Before closing, the server sends `session.ended` with a reason. The client then sees `disconnect` with reason `io server disconnect`. Socket.IO does **not** reconnect by itself after a server disconnect, so act on the reason:

| `reason` | Client action |
|---|---|
| `token_expired` | The access token's `exp` passed (every 15 minutes). Refresh through REST, then `socket.connect()` |
| `server_shutting_down` | A deploy. `socket.connect()` after a short random delay (0–5 s) |
| `account_suspended` | Log out |

`account_suspended` comes from another task through Redis, so it can arrive after the disconnect or not at all. A reconnect attempt then fails with `UNAUTHENTICATED`, and so does the refresh: log out.

## Messages (server → client)

The Socket.IO event name is the message `type`. Its single argument is the envelope:

```ts
interface RealtimeMessage<T> {
  type: string;       // also the event name
  eventId: string;    // the source domain event
  occurredAt: string; // ISO-8601
  data: T;            // ids and statuses only: no names, addresses, phones or amounts
}
```

One domain event can produce several messages that share its `eventId` (for example `order.updated` and `payment.updated`). **Drop duplicates by `eventId` + `type`**, not by `eventId` alone. Statuses use the REST enum values.

| `type` | `data` | Who receives it |
|---|---|---|
| `order.updated` | `{ orderId, orderNumber, status }` | The customer. On order placed and closed, and on payment paid / failed / expired. `status` is the order's current status |
| `seller_order.placed` | `{ sellerOrderId, orderNumber }` | Each seller of a new order (not while it awaits payment) |
| `seller_order.updated` | `{ sellerOrderId, orderId, status }` | The customer and that seller: accepted, ready for pickup, items cancelled, cancelled, returned, delivered. `status` is current |
| `shipment.updated` | `{ shipmentId, sellerOrderId, orderId, status }` | The customer and the agent: `picked_up`, `out_for_delivery`, `delivery_failed`, `returning_to_seller`, `delivered` |
| `shipment.assigned` | `{ shipmentId, sellerOrderId }` | The newly assigned agent |
| `shipment.unassigned` | `{ shipmentId, sellerOrderId }` | The agent the shipment was taken from |
| `payment.updated` | `{ orderId, paymentStatus }` | The customer: `paid`, `failed`, `expired`. After the Kashier redirect, wait for this (about 30 s) instead of polling. Fall back to `GET /orders/:id` every 5 s (RT-4) |
| `media.updated` | `{ mediaId, status }` | The uploader: `ready` or `failed` |
| `notification.created` | `{ notificationId, category, title, body, link }` | The recipient, after the in-app notification is stored (spec 13). `link` is a web app route or null |
| `support.message_created` | `{ ticketId, messageId }` | Sockets in the ticket's room, plus the other side: the opener for an admin reply or a system line, the `admins` room for the opener's message. An internal note goes to `admins` only. Refetch `…/messages` |
| `support.ticket_updated` | `{ ticketId, status, assignedAdminId }` | The ticket's room, the opener and `admins`, when a ticket opens, is assigned or changes status. `status` and `assignedAdminId` are current |
| `support.typing` | `{ ticketId, userId, role }` | The others in the ticket's room, relayed from a `support.typing` signal. Never stored; show it for a few seconds |
| `session.ended` | `{ reason }` | That socket, just before the server closes it (see above) |

Arrive in later Release 2 phases: `return.updated` and refund `payment.updated` (specs 18, 10).

## Signals (client → server)

Emit with an ack where one is listed: `await socket.emitWithAck(signal, payload)`.

| Signal | Payload | Effect | Ack |
|---|---|---|---|
| `ticket.subscribe` | `{ ticketId }` | Joins the ticket's room, if you are its opener or an admin | `{ ok: true }`, or `{ ok: false, code }` with `SUPPORT_TICKET_NOT_FOUND` (missing or not yours), `VALIDATION_FAILED`, `RATE_LIMITED`, `INTERNAL_ERROR` (retry) |
| `ticket.unsubscribe` | `{ ticketId }` | Leaves the room | `{ ok: true }` or `VALIDATION_FAILED` |
| `support.typing` | `{ ticketId }` | Relayed as `support.typing` to the others in the room; ignored unless you joined it | none |

Rooms are per socket: subscribe again after every reconnect, for the ticket on screen. The gateway ignores unknown events. The rules for every signal:

- At most `REALTIME_SIGNAL_RATE_PER_SECOND` signals (5) per second per socket. A signal over the limit sent with an ack gets `{ ok: false, code: 'RATE_LIMITED' }`.
- At most 4 KB per frame. A larger frame closes the socket.
- An invalid payload is acked `{ ok: false, code: 'VALIDATION_FAILED' }`.
