# Spec 11 — delivery

Status: **v1.2 APPROVED (2026-10-12).** v1.0 (2026-10-09): the reference-data part, with the clarifications in §7.1. v1.1: the whole spec (agents, shipments, assignment) approved with the Phase 6 clarifications in §7.2. v1.2: how the consumer orders item cancellations and returns (DE-15, DE-16). Changes from now on need explicit approval and a version bump.
**v2.1 APPROVED (2026-10-20):** §8.4 `getUserIds` (DE-20). **v2.0 APPROVED (2026-10-20):** §8 adds the Release 2 return shipments (spec 18), a dashboard method, and the paid-amount payload change (spec 09 §8.8). Kept as its own section, so every cross-reference stays valid (R2-Q1). §8.6 DE-17…DE-19 answered 2026-10-20.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Governorates + delivery fees, the global agent fee-share setting, delivery agents (created by admins), shipments (one per seller order), automatic and manual assignment, delivery attempts, COD collection at the door.
Tables: `governorates`, `delivery_settings`, `delivery_agents`, `shipments`, `shipment_attempts`, `shipment_status_history`.
Depends on: `identity` (create invited agent users, suspend/reactivate them).

Enums:
- `ShipmentStatus`: `unassigned, assigned, picked_up, out_for_delivery, delivery_failed, returning_to_seller, returned_to_seller, delivered, cancelled`
- `AgentStatus`: `active, inactive`
- `AttemptFailureReason`: `customer_unreachable, customer_refused, wrong_address, customer_rescheduled`
- **Active** shipment statuses (for the agent's load and lists): `assigned, picked_up, out_for_delivery, delivery_failed, returning_to_seller`.

Config: `JOB_SHIPMENT_ASSIGNMENT_RETRY_INTERVAL_MS`, `SHIPMENT_JOBS_BATCH_SIZE` (worker, DE-9; architecture §6).

### 1.1 Shipment state machine
| From | To | Trigger |
|---|---|---|
| – | `unassigned` | `seller_order.ready_for_pickup` |
| `unassigned` | `assigned` | auto-assignment / admin |
| `assigned` | `assigned` (other agent) | admin reassign |
| `assigned` | `picked_up` | agent |
| `picked_up`, `delivery_failed` | `out_for_delivery` | agent (attempt n) |
| `out_for_delivery` | `delivered` | agent |
| `out_for_delivery` | `delivery_failed` | agent, attempt < 3 and reason ≠ `customer_refused` |
| `out_for_delivery` | `returning_to_seller` | agent, reason = `customer_refused` or attempt = 3 |
| `returning_to_seller` | `returned_to_seller` | `seller_order.returned` (seller confirmed), or the agent confirms the handover when the seller order was cancelled after pickup (DE-6) |
| `unassigned`, `assigned` | `cancelled` | `seller_order.cancelled` |
| `picked_up`, `out_for_delivery`, `delivery_failed` | `returning_to_seller` | `seller_order.cancelled` arriving late (race, §3.5) |

Each transition: conditional update + `shipment_status_history` row (+ outbox where listed in §5).

## 2. Public API (`index.ts`)

| Method | Caller | Notes |
|---|---|---|
| `getGovernorateFees(ids) → { id, name, deliveryFee: string \| null }[]` | ordering | From cache |
| `getAgentFeeShareRate() → string` | ordering | |
| `getAgentByUserId(userId) → { agentId, status } \| null` | finance | Profile resolution for `/agent/finance/*` (built in Phase 6, DE-11) |
| `getAgentSummaries(ids) → { agentId, fullName, phone }[]` | finance | Admin finance views |

## 3. Use cases

### UC-DE-1 Shipment creation + auto-assignment (consumer of `seller_order.ready_for_pickup`, architecture §7.3)
1. Insert the shipment from the payload (`ON CONFLICT (seller_order_id) DO NOTHING`: replay-safe), `status = unassigned`, `attempt_count = 0`, `carries_delivery_fee = false`, `cod_fee_amount = 0`.
2. Candidate: `status = 'active' AND on_shift AND home_governorate_id = pickup governorate`, ordered by active-shipment count, then `last_assigned_at NULLS FIRST`, `FOR UPDATE SKIP LOCKED LIMIT 1`.
3. Found → `assigned`, `agent_id`, `assigned_at`, agent `last_assigned_at = now()`, outbox `shipment.assigned (auto)`. Not found → stays `unassigned`; the retry job runs step 2–3 for every `unassigned` shipment (oldest first).

### UC-DE-2 Agent availability
Every agent endpoint except `GET /agent/profile` requires an `active` agent, else `403 AGENT_INACTIVE` (DE-5). `on_shift` toggle. Going off shift keeps current shipments (they must still be finished); it only stops new auto-assignments. An `inactive` agent can't go on shift.

### UC-DE-3 Agent works a shipment
Ownership: `shipments.agent_id = my agent id`, else `404 SHIPMENT_NOT_FOUND`.
- **Picked up:** `assigned → picked_up`, `picked_up_at`. Outbox `shipment.picked_up`.
- **Out for delivery:** `picked_up | delivery_failed → out_for_delivery`. COD fee carrier (SD-2, DB-Q1), in one transaction with all shipments of the checkout locked (`WHERE order_id = ? FOR UPDATE`): if **no** shipment of the checkout has `carries_delivery_fee`, this one takes it (`carries_delivery_fee = true`, `cod_fee_amount = order_delivery_fee`). Outbox `shipment.out_for_delivery`. The response shows `amountToCollect`.
- **Delivered:** `out_for_delivery → delivered`, `delivered_at`. COD: `codCollectedAmount` must equal `cod_items_amount + cod_fee_amount` → else `COD_AMOUNT_MISMATCH`. Kashier: `codCollectedAmount` must be absent. Sets `cod_collected_amount`. Outbox `shipment.delivered`. The fee carrier keeps `carries_delivery_fee = true` (it's now "collected").
- **Failed attempt:** `attempt_count + 1`, a `shipment_attempts` row. `customer_refused` or the 3rd attempt → `returning_to_seller`, else `delivery_failed`. If this shipment carried the fee, release it (`carries_delivery_fee = false`, `cod_fee_amount = 0`) so the next shipment going out takes it. Outbox `shipment.attempt_failed`.

**Known gap in DB-Q1 (S-3, accepted for R1):** if the fee carrier fails *after* a sibling shipment was already delivered without the fee, and no other sibling goes out afterwards, the COD fee is never collected although the checkout had a delivery. Spec 12 books revenue only on the fee actually collected, so the ledger stays correct. The loss is logged as `warn COD_DELIVERY_FEE_UNCOLLECTED`.

### UC-DE-4 Admin assignment
Assign or reassign in `unassigned` / `assigned` only (Q-41). After `picked_up` the parcel is with the agent, so R1 doesn't support reassigning it (S-18). The target agent must be `active` (not necessarily on shift or in the same governorate: the admin can override). Outbox `shipment.assigned (admin, previousAgentId)`.

### UC-DE-5 Seller-order updates (consumer `delivery.seller-order-updates`)
- `seller_order.items_cancelled`: shipment in `unassigned`/`assigned` and COD → `cod_items_amount = newSubtotal`. Picked up already → `warn` (can't happen under Q-31, except in a race).
- `seller_order.cancelled`:
  - Shipment `unassigned`/`assigned` → `cancelled`.
  - Shipment `picked_up`/`out_for_delivery`/`delivery_failed` (the agent picked it up while the seller was cancelling) → `returning_to_seller`, `seller_order_cancelled_at = now()`, fee carrier released + `warn` `SHIPMENT_CANCELLED_AFTER_PICKUP`. Stock was already released by the cancellation, so the seller just takes the parcel back, and the **agent** confirms the handover (`POST /agent/shipments/:id/returned`, DE-6): ordering ignores later shipment events for a cancelled seller order, so `seller_order.returned` never comes.
  - No shipment yet and `previousStatus = ready_for_pickup` → the `ready_for_pickup` event hasn't been applied yet (out of order): **reject for retry** so it's re-delivered after the shipment exists. Any other `previousStatus` → no shipment is expected; ack.
- `seller_order.returned`: `returning_to_seller → returned_to_seller`, `returned_at`.

### UC-DE-6 Admin manages agents
- Create: `identity.createInvitedUser(role = delivery_agent)` + `delivery_agents` (`status = active`, `on_shift = false`) in one transaction. The agent gets an invite email.
- Deactivate: only with **no active shipments** → `AGENT_HAS_ACTIVE_SHIPMENTS` (the admin reassigns first). Sets `inactive`, `on_shift = false`, and, when the user is `active`, `identity.setUserStatus(suspended)` so the agent can't log in (S-10). A still-`invited` user is left as is (identity allows only `active ⇄ suspended`, spec 03 I-6); the inactive agent can do nothing anyway (DE-5).
- Activate: `active`, and `identity.setUserStatus(active)` when the user is `suspended` (DE-5).

### UC-DE-7 Admin manages fees
- Governorate fee: `money` or `null` (= not deliverable, Q-26). Affects new checkouts only (snapshot). Invalidates the governorates cache.
- Agent fee-share rate (global, Q-34): affects new checkouts only (snapshot on `orders`).

## 4. Endpoints

### 4.1 Public   auth: public · rate: general
`GET /governorates` → `200 { id: string; code: string; name: string; deliveryFee: string | null; isDeliverable: boolean }[]` (all 27, ordered by name, cached). All of them are returned because addresses and pickup addresses may use any governorate.

### 4.2 Agent   auth: delivery_agent · rate: general
```ts
interface AgentProfileDto {
  id: string; email: string; fullName: string; phone: string; homeGovernorateId: string;
  status: AgentStatus; onShift: boolean; activeShipmentCount: number;
}
interface AgentShipmentDto {
  id: string; sellerOrderId: string; orderNumber: string; status: ShipmentStatus;
  paymentMethod: PaymentMethod;
  pickup: { businessName: string; phone: string; governorateId: string; city: string; area: string;
            street: string; building: string; landmark: string | null };
  dropoff: { recipientName: string; recipientPhone: string; governorateId: string; governorateName: string;
             city: string; area: string; street: string; building: string;
             floor: string | null; apartment: string | null; landmark: string | null };
  codItemsAmount: string; codFeeAmount: string;
  amountToCollect: string;            // COD: items + fee. Kashier: "0.00"
  attemptCount: number;
  attempts: { attemptNumber: number; reason: AttemptFailureReason; note: string | null; createdAt: string }[];
  assignedAt: string | null; pickedUpAt: string | null; deliveredAt: string | null;
}
```

| Endpoint | idem | Body | Success | Errors |
|---|---|---|---|---|
| `GET /agent/profile` | – | – | `200 AgentProfileDto` | – |
| `PATCH /agent/availability` | – | `onShift bool` | `200 AgentProfileDto` | `AGENT_INACTIVE` 409 |
| `GET /agent/shipments` | – | whitelist `status` (`eq,in`; default = active statuses), `createdAt` (`gte,lte`, sort, default `createdAt` ascending) | `200 AgentShipmentDto[]` + meta | – |
| `GET /agent/shipments/:shipmentId` | – | – | `200 AgentShipmentDto` | `SHIPMENT_NOT_FOUND` 404 |
| `POST /agent/shipments/:shipmentId/picked-up` | – | – | `200 AgentShipmentDto` | `SHIPMENT_NOT_FOUND`, `SHIPMENT_INVALID_STATUS_TRANSITION` 409 |
| `POST /agent/shipments/:shipmentId/out-for-delivery` | – | – | `200 AgentShipmentDto` | same |
| `POST /agent/shipments/:shipmentId/delivered` | required | `codCollectedAmount opt money` (required for COD, forbidden for Kashier) | `200 AgentShipmentDto` | same + `COD_AMOUNT_MISMATCH` 422, `COD_AMOUNT_REQUIRED` 422, `COD_AMOUNT_NOT_ALLOWED` 422 |
| `POST /agent/shipments/:shipmentId/failed-attempt` | required | `reason enum(AttemptFailureReason)` · `note opt str(1..500)` | `200 AgentShipmentDto` | `SHIPMENT_NOT_FOUND`, `SHIPMENT_INVALID_STATUS_TRANSITION` |
| `POST /agent/shipments/:shipmentId/returned` | required | – | `200 AgentShipmentDto` | `SHIPMENT_NOT_FOUND`, `SHIPMENT_INVALID_STATUS_TRANSITION` (only a `returning_to_seller` shipment whose seller order was cancelled, DE-6) |

Every endpoint above except `GET /agent/profile` answers `403 AGENT_INACTIVE` for an inactive agent (DE-5).

`picked-up` and `out-for-delivery` have no money/stock effect and are guarded by the state machine, so they don't need an idempotency key.

### 4.3 Admin   auth: admin · rate: general

```ts
interface AdminAgentDto extends AgentProfileDto { lastAssignedAt: string | null; createdAt: string; userStatus: string }
interface AdminShipmentDto extends AgentShipmentDto {
  orderId: string; agentId: string | null; carriesDeliveryFee: boolean; codCollectedAmount: string | null;
  history: { fromStatus: string | null; toStatus: string; actorRole: string; actorUserId: string | null;
             reason: string | null; createdAt: string }[];
  createdAt: string;
}
```

| Endpoint | Body / query | Success | Errors |
|---|---|---|---|
| `GET /admin/governorates` | – | `200` same as public | – |
| `PATCH /admin/governorates/:governorateId` | `deliveryFee nullable money` | `200` governorate | `GOVERNORATE_NOT_FOUND` 404 |
| `GET /admin/settings/delivery` | – | `200 { agentFeeShareRate: string; updatedAt: string }` | – |
| `PUT /admin/settings/delivery` | `agentFeeShareRate rate` | `200` same | – |
| `POST /admin/delivery-agents` | `email email` · `fullName str(1..100)` · `phone phone` · `homeGovernorateId uuid` | `201 AdminAgentDto` | `EMAIL_ALREADY_REGISTERED` 409, `GOVERNORATE_NOT_FOUND` 422 |
| `GET /admin/delivery-agents` | whitelist `status` (`eq`), `onShift` (`eq`), `homeGovernorateId` (`eq`), `fullName` (`like`), `createdAt` (`gte,lte`, sort, default `-createdAt`) | `200 AdminAgentDto[]` + meta | – |
| `GET /admin/delivery-agents/:agentId` | – | `200 AdminAgentDto` | `AGENT_NOT_FOUND` 404 |
| `PATCH /admin/delivery-agents/:agentId` | `fullName opt` · `phone opt` · `homeGovernorateId opt uuid` | `200` | `AGENT_NOT_FOUND`, `GOVERNORATE_NOT_FOUND` 422 |
| `POST /admin/delivery-agents/:agentId/deactivate` | – | `200` | `AGENT_NOT_FOUND`, `AGENT_HAS_ACTIVE_SHIPMENTS` 409, `AGENT_INVALID_STATUS_TRANSITION` 409 |
| `POST /admin/delivery-agents/:agentId/activate` | – | `200` | `AGENT_NOT_FOUND`, `AGENT_INVALID_STATUS_TRANSITION` |
| `GET /admin/shipments` | whitelist `status` (`eq,in`), `agentId` (`eq`), `orderId` (`eq`), `createdAt` (`gte,lte`, sort, default `-createdAt`) | `200 AdminShipmentDto[]` (without `history`) + meta | – |
| `GET /admin/shipments/:shipmentId` | – | `200 AdminShipmentDto` | `SHIPMENT_NOT_FOUND` |
| `POST /admin/shipments/:shipmentId/assign` | `agentId uuid` | `200 AdminShipmentDto` | `SHIPMENT_NOT_FOUND`, `AGENT_NOT_FOUND` 422, `AGENT_INACTIVE` 409, `SHIPMENT_NOT_ASSIGNABLE` 409, `SHIPMENT_ALREADY_ASSIGNED_TO_AGENT` 409 |

Indexes for these lists: D-3 and D-10 (database v1.10, DE-14).

## 5. Events
Published: `shipment.assigned`, `shipment.picked_up`, `shipment.out_for_delivery`, `shipment.attempt_failed`, `shipment.delivered`.
Consumed: `seller_order.ready_for_pickup`, `seller_order.items_cancelled`, `seller_order.cancelled`, `seller_order.returned` (`delivery.seller-order-updates`).

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `GOVERNORATE_NOT_FOUND` | 404 / 422 | Path / body reference |
| `AGENT_NOT_FOUND` | 404 / 422 | |
| `AGENT_INACTIVE` | 409 / 403 | 409: an inactive agent goes on shift, or is chosen for assignment. 403: an inactive agent calls an agent endpoint other than the profile (DE-5) |
| `AGENT_HAS_ACTIVE_SHIPMENTS` | 409 | Deactivate with active shipments |
| `AGENT_INVALID_STATUS_TRANSITION` | 409 | |
| `SHIPMENT_NOT_FOUND` | 404 | Missing or another agent's |
| `SHIPMENT_INVALID_STATUS_TRANSITION` | 409 | |
| `SHIPMENT_NOT_ASSIGNABLE` | 409 | Admin assign after `picked_up` |
| `SHIPMENT_ALREADY_ASSIGNED_TO_AGENT` | 409 | Reassign to the same agent |
| `COD_AMOUNT_MISMATCH` | 422 | Collected ≠ expected |
| `COD_AMOUNT_REQUIRED` | 422 | COD delivered without an amount |
| `COD_AMOUNT_NOT_ALLOWED` | 422 | Kashier delivered with an amount |

## 7. Decisions (answered 2026-10-08, `00-overview.md` §9.1). No open questions.
- **S-10** Agent deactivation suspends the login.
- **S-18** No reassignment after pickup.
- **S-3** The COD fee gap in DB-Q1 is accepted for R1 (§3, UC-DE-3).

### 7.1 Clarifications for the reference-data part (v1.0, Phase 2 plan, 2026-10-09)

| # | Clarification | Where |
|---|---|---|
| DE-1 | Governorate `name` is English (ISO 3166-2:EG). The app shows its own localized label keyed by `code`, which never changes (P2-Q3) | §4.1 |
| DE-2 | The migration seeds all 27 governorates with `delivery_fee = NULL`: nothing is deliverable until an admin sets fees. A dev-only seed script sets sample fees locally (P2-Q4) | UC-DE-7 |
| DE-3 | Governorates cache: Redis key `v1:delivery:governorates`, TTL `GOVERNORATES_CACHE_TTL_SECONDS` (env, value 3600, no default), deleted after commit on a fee change. `delivery_settings` is not cached (P2-Q5) | §2, §4.1, UC-DE-7 |
| DE-4 | `GOVERNORATE_NOT_FOUND` is the common code from `lib/error` (P2-Q7) | §6 |

### 7.2 Clarifications for agents, shipments and assignment (v1.1, Phase 6 plan, 2026-10-12)

| # | Clarification | Where |
|---|---|---|
| DE-5 | Every agent endpoint except `GET /agent/profile` requires an `active` agent (`403 AGENT_INACTIVE`). Deactivate suspends the login only when it is `active`; activate reactivates it only when it is `suspended`; an `invited` user is left as is (P6-Q4) | UC-DE-2, UC-DE-6, §4.2 |
| DE-6 | A shipment cancelled after pickup gets `seller_order_cancelled_at`; the agent confirms its handover with `POST /agent/shipments/:id/returned` → `returned_to_seller` (normal returns still close on `seller_order.returned`) (P6-Q5) | §1.1, UC-DE-3, UC-DE-5 |
| DE-7 | Lock order: shipments of one checkout by id → the shipment's agent → other agents. Delivery never locks ordering's or payments' rows; their consumers never lock shipments (P6-Q6) | §3 |
| DE-8 | Fee carrier: COD shipments only (Kashier: `order_delivery_fee` and `amountToCollect` `0.00`); chosen at `out-for-delivery` under the checkout's shipment locks; released on a failed attempt or a cancellation after pickup; `shipment.delivered` reports `deliveryFeeCollected = carries_delivery_fee`, `deliveryFeeAmount = cod_fee_amount`, `codCollectedAmount = items + fee` (P6-Q7) | UC-DE-3 |
| DE-9 | Retry job `shipment-assignment-retry`: `unassigned` shipments oldest first, one short transaction per shipment (`FOR UPDATE SKIP LOCKED`), env `JOB_SHIPMENT_ASSIGNMENT_RETRY_INTERVAL_MS` (60 000) and `SHIPMENT_JOBS_BATCH_SIZE` (100), worker only (P6-Q9) | §1, UC-DE-1 |
| DE-10 | Event order (as spec 09 OR-14): a seller-order event whose shipment doesn't exist yet but should (`previousStatus` / the seller order's state says so) is retried; a stale one is a `warn` no-op; `seller_order.ready_for_pickup` is replay-safe (P6-Q8) | UC-DE-5 |
| DE-11 | `getAgentByUserId` and `getAgentSummaries` are built in Phase 6 for finance (P6-Q11) | §2 |
| DE-12 | Without a `status` filter, `GET /agent/shipments` returns the active statuses, oldest `createdAt` first; history through `status[in]=…` (P6-Q10) | §4.2 |
| DE-13 | Process split: api serves the agent / admin endpoints and the public API; the worker runs `delivery.seller-order-updates` and the retry job; both share one assignment service (P6-Q12) | §3 |
| DE-14 | Shipments snapshot from `seller_order.ready_for_pickup` everything the agent's screen and the fee rules need: `order_number`, `payment_method`, `order_delivery_fee` (`0.00` for Kashier), `pickup_business_name`, the full pickup and drop-off snapshots, `cod_items_amount`; no `agent_fee_share` (ordering computes it) (D-2, P6-Q2). Indexes D-3, D-10 (P6-Q3) | §1, UC-DE-1 |
| DE-15 | `seller_order.items_cancelled` (with `previousStatus`, spec 02 E-8): shipment `unassigned`/`assigned` and COD → `cod_items_amount = newSubtotal` only when lower (subtotals only go down, so an older event overtaken by a newer one is a `warn` no-op); Kashier → nothing to change; picked up or later → `warn`; no shipment and `previousStatus = ready_for_pickup` → retried, otherwise acked (Phase 6 step 6, v1.2) | UC-DE-5 |
| DE-16 | `seller_order.returned` for a shipment that doesn't exist is retried (it always exists before any shipment event); one not `returning_to_seller` is a `warn` no-op. `seller_order.cancelled` on a shipment already finished, returning or cancelled is a `warn` no-op. The after-pickup branch locks the checkout's shipments (DE-7) because it releases the fee (Phase 6 step 6, v1.2) | UC-DE-5 |

---

## 8. Release 2: return shipments [v2.0, approved 2026-10-20]

### 8.1 Model
- `shipments.kind` `VARCHAR(10)`: `ShipmentKind` `delivery, return` (CHECK; existing rows filled with `delivery`). A return shipment has `return_id` (unique, nullable for `delivery`; `CHECK (kind = 'return') = (return_id IS NOT NULL)`), and `seller_order_id` is no longer unique on its own: `uq_shipments_seller_order_id` becomes partial `WHERE kind = 'delivery'` (database v2.0).
- Snapshots: **pickup = the customer** (the order's drop-off address), **drop-off = the seller** (pickup address + business name), from `return.approved`. Payment method fields are `kashier`-like: nothing to collect (`cod_items_amount = 0`, never a fee carrier).
- `ShipmentStatus` gains `pickup_failed`. A return shipment uses: `unassigned → assigned → picked_up → delivered`, `assigned | pickup_failed → picked_up`, `assigned | pickup_failed → pickup_failed` (attempt < 3), third failed attempt → `cancelled`, and `unassigned | assigned | pickup_failed → cancelled` (the customer cancelled the return).
- Auto-assignment (UC-DE-1) as for deliveries, keyed on the **pickup** governorate, which is now the customer's (DE-17). Active-load counting includes return shipments.
- Attempt reasons for a failed pickup: `customer_unreachable, customer_refused, wrong_address, customer_rescheduled`; `customer_refused` ends it at once (`cancelled`), like a refused delivery.

### 8.2 Use cases
- **UC-DE-8 Create** (consumer `delivery.return-updates` ← `return.approved`): insert `ON CONFLICT (return_id) DO NOTHING`, then auto-assign. Outbox `shipment.assigned` (payload gains `kind`).
- **UC-DE-9 Agent works a return:** `POST /agent/shipments/:id/picked-up` (from `assigned | pickup_failed`), `/failed-attempt` (pickup attempt), `/delivered` (handed to the seller; no amount). Outbox `return_shipment.picked_up`, `return_shipment.delivered` (`{ shipmentId, returnId, agentId, at }`), and `return_shipment.failed` when the attempts end. `/out-for-delivery` and `/returned` answer `409 SHIPMENT_INVALID_STATUS_TRANSITION` for return shipments.
- **UC-DE-10 Cancel** (← `return.status_changed` with `to = cancelled`): `unassigned | assigned | pickup_failed → cancelled`. Already `picked_up` → `warn` no-op (returns refuses the cancel in that case, spec 18 UC-RE-5).
- Admin assignment (UC-DE-4) works the same for return shipments (until `picked_up`).
- The agent's fee share for a return is booked by finance from `return.completed` (spec 12 §8); delivery only reports the agent.

### 8.3 Reads
`AgentShipmentDto` and `AdminShipmentDto` gain `kind` and `returnId`; for returns the agent sees the customer as pickup and the seller as drop-off, and `amountToCollect = "0.00"`. `GET /agent/shipments` and `/admin/shipments` gain the filter `kind` (`eq`).

### 8.4 Other changes
- `seller_order.items_cancelled` consumer uses `newPaidSubtotal` for `cod_items_amount` (spec 09 §8.8); `codItemsAmount` of `ready_for_pickup` is already the paid amount.
- New public method `getDashboardStats() → { awaitingAssignment, outForDelivery, returnsInProgress }` (spec 20 §3.2), one aggregate.
- **DE-20 (v2.1, approved 2026-10-20):** new public method `getUserIds(agentIds) → Map<agentId, userId>` on `IDeliveryAgentDirectory`, batched, unknown ids left out. Spec 02 §6.3 and spec 13 §8 resolve agent recipients "through the owning module" (and plan R2-P2 step 3 lists it), but this section had not named the method. Realtime does not need it (it joins `agent:<agentId>` rooms); notifications does (push to an agent's user, NO-10).

### 8.5 Events
Published (new): `return_shipment.picked_up`, `return_shipment.delivered`, `return_shipment.failed` → returns (`returns.shipment-updates`), realtime. `shipment.assigned` gains `kind` and `returnId`. Ordering's `ordering.shipment-updates` never receives return events (different names), so R1 consumers are untouched.
Consumed (new queue `delivery.return-updates`): `return.approved`, `return.status_changed`.

### 8.6 Decisions (answered 2026-10-20)

The user accepted every recommendation (2026-10-20). The table is kept for the reasoning; the answers are logged in `00-overview.md` §10.11.

| # | Topic | Options / recommendation |
|---|---|---|
| DE-17 | Which agent picks up a return | **Rec:** auto-assignment by the customer's governorate (the pickup), same algorithm as deliveries · or always manual admin assignment |
| DE-18 | Pickup attempts | **Rec:** up to 3, `customer_refused` ends at once; then the return is `pickup_failed` and no fee is charged · or a single attempt |
| DE-19 | Seller absent at hand-over | **Rec:** not modelled in R2: the agent keeps the parcel and an admin sorts it out (support ticket) · or a failed drop-off status with retries |
