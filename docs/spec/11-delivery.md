# Spec 11 — delivery

Status: **DRAFT v0.1 (2026-10-08), under review.** [PROPOSED] unless it restates overview §4.6 / §4.7, SD-2, DB-Q1.
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

Config: `SHIPMENT_ASSIGNMENT_RETRY_INTERVAL_SECONDS` (architecture §6).

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
| `returning_to_seller` | `returned_to_seller` | `seller_order.returned` (seller confirmed) |
| `unassigned`, `assigned` | `cancelled` | `seller_order.cancelled` |
| `picked_up`, `out_for_delivery`, `delivery_failed` | `returning_to_seller` | `seller_order.cancelled` arriving late (race, §3.5) |

Each transition: conditional update + `shipment_status_history` row (+ outbox where listed in §5).

## 2. Public API (`index.ts`)

| Method | Caller | Notes |
|---|---|---|
| `getGovernorateFees(ids) → { id, name, deliveryFee: string \| null }[]` | ordering | From cache |
| `getAgentFeeShareRate() → string` | ordering | |
| `getAgentByUserId(userId) → { agentId, status } \| null` | finance | Profile resolution for `/agent/finance/*` |
| `getAgentSummaries(ids) → { agentId, fullName, phone }[]` | finance | Admin finance views |

## 3. Use cases

### UC-DE-1 Shipment creation + auto-assignment (consumer of `seller_order.ready_for_pickup`, architecture §7.3)
1. Insert the shipment from the payload (`ON CONFLICT (seller_order_id) DO NOTHING`: replay-safe), `status = unassigned`, `attempt_count = 0`, `carries_delivery_fee = false`, `cod_fee_amount = 0`.
2. Candidate: `status = 'active' AND on_shift AND home_governorate_id = pickup governorate`, ordered by active-shipment count, then `last_assigned_at NULLS FIRST`, `FOR UPDATE SKIP LOCKED LIMIT 1`.
3. Found → `assigned`, `agent_id`, `assigned_at`, agent `last_assigned_at = now()`, outbox `shipment.assigned (auto)`. Not found → stays `unassigned`; the retry job runs step 2–3 for every `unassigned` shipment (oldest first).

### UC-DE-2 Agent availability
`on_shift` toggle. Going off shift keeps current shipments (they must still be finished); it only stops new auto-assignments. An `inactive` agent can't go on shift.

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
  - Shipment `picked_up`/`out_for_delivery`/`delivery_failed` (the agent picked it up while the seller was cancelling) → `returning_to_seller` + `warn` `SHIPMENT_CANCELLED_AFTER_PICKUP`. Stock was already released by the cancellation, so the seller just takes the parcel back. Ordering ignores later shipment events for a cancelled seller order.
  - No shipment yet and `previousStatus = ready_for_pickup` → the `ready_for_pickup` event hasn't been applied yet (out of order): **reject for retry** so it's re-delivered after the shipment exists. Any other `previousStatus` → no shipment is expected; ack.
- `seller_order.returned`: `returning_to_seller → returned_to_seller`, `returned_at`.

### UC-DE-6 Admin manages agents
- Create: `identity.createInvitedUser(role = delivery_agent)` + `delivery_agents` (`status = active`, `on_shift = false`) in one transaction. The agent gets an invite email.
- Deactivate: only with **no active shipments** → `AGENT_HAS_ACTIVE_SHIPMENTS` (the admin reassigns first). Sets `inactive`, `on_shift = false`, and `identity.setUserStatus(suspended)` so the agent can't log in (S-10).
- Activate: `active` + `identity.setUserStatus(active)`.

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

Index note: `GET /admin/shipments` filtered by `status` only, or unfiltered and sorted by `created_at`, has no matching index in `02-database.md`. Proposed: `idx_shipments_status_created_at_id (status, created_at DESC, id DESC)` (D-3).

## 5. Events
Published: `shipment.assigned`, `shipment.picked_up`, `shipment.out_for_delivery`, `shipment.attempt_failed`, `shipment.delivered`.
Consumed: `seller_order.ready_for_pickup`, `seller_order.items_cancelled`, `seller_order.cancelled`, `seller_order.returned` (`delivery.seller-order-updates`).

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `GOVERNORATE_NOT_FOUND` | 404 / 422 | Path / body reference |
| `AGENT_NOT_FOUND` | 404 / 422 | |
| `AGENT_INACTIVE` | 409 | Inactive agent goes on shift, or is chosen for assignment |
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
