# Spec 18 — returns

Status: **v1.2 APPROVED (2026-10-22).** v1.2: RE-21 the return number format (§7.1). v1.1: R2-P6 plan clarifications RE-11…RE-20 (§7.1, every recommendation accepted). **v1.0 APPROVED (2026-10-20).** Changes from now on need explicit approval and a version bump. Release 2. Inputs: `00-overview.md` v2.0 §10.4 (returns and refunds, holding period), R-13…R-16, `14-media.md` (return photos), spec 09 v2.0 §8.7, spec 10 v2.0 §8, spec 11 v2.0 §8, spec 12 v2.0 §8, spec 07 v2.0 §8. §7 RE-1…RE-10 answered 2026-10-20 (every recommendation accepted).
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

A customer asks to return delivered items. The seller decides; an admin settles escalations and disputes. An approved return travels back to the seller in a **return shipment** (delivery). When the seller confirms receipt, ordering records the returned quantities, inventory restocks what the seller chose, and payments refunds the customer.

Tables:
- `return_requests`: one per request; `return_number` (`R-` + a sequence)
- `return_items`: order item, quantity, restock decision
- `return_photos`: private media (spec 14, purpose `return_photo`)
- `return_status_history`

Depends on:
- `ordering`: returnable items and amounts, logistics snapshots, recording the return (spec 09 §8.7)
- `inventory`: restock (spec 07 §8)
- `payments`: refund status for the return views (spec 10 §8)
- `delivery`: the current return fee and agent share rate (spec 11 §2)
- `media`: photos

Nothing calls returns synchronously except finance (`getOpenReturnSellerOrderIds`, holding period, spec 12 §8) and backoffice (stats). Neither is a dependency of returns, so the graph stays acyclic.

Enums:
- `ReturnReason`: `damaged, wrong_item, not_as_described, changed_mind` (R-13). The first three are **seller-fault** reasons.
- `ReturnStatus`: `requested, rejected, escalated, approved, picked_up, received, disputed` (open) · `completed, refused, cancelled, pickup_failed` (terminal)
- `ReturnRefusalReason`: `seller_rejected` (escalation window lapsed), `admin_rejected`, `dispute_upheld`
- `ReturnFeePayer`: `seller, customer`
- `RefundPayoutMethod` (COD only): `mobile_wallet, instapay`

Limits:
- **env:** `RETURN_WINDOW_DAYS` (14, R-13; also read by finance for the holding period), `RETURN_SELLER_DECISION_HOURS` (48, R-14), `RETURN_ESCALATION_WINDOW_DAYS` (7, RE-3), `RETURN_INSPECTION_HOURS` (48, RE-6), `JOB_RETURNS_INTERVAL_MS`, `RETURN_JOBS_BATCH_SIZE`.
- **constants:** description `1..1000`; photos `0..4`, at least 1 for seller-fault reasons (RE-2); reject / dispute / admin note `3..500`.

### 1.1 Status machine
```
requested ──seller approves | no answer in 48 h (job) | admin approves──► approved
requested ──seller rejects──► rejected ──customer escalates (≤ 7 days)──► escalated
rejected ──escalation window lapses (job)──► refused (seller_rejected)
escalated ──admin approves──► approved          escalated ──admin rejects──► refused (admin_rejected)
requested | approved ──customer cancels (before pickup)──► cancelled
approved ──return_shipment.picked_up──► picked_up ──return_shipment.delivered──► received
approved ──return_shipment.failed (3 pickup attempts)──► pickup_failed
received ──seller confirms | no answer in 48 h (job)──► completed
received ──seller disputes──► disputed ──admin: refund──► completed
                                      ──admin: no refund──► refused (dispute_upheld)
```
- Every transition is a conditional update on the expected status + a history row (actor, reason) + outbox `return.status_changed`.
- **Open** = any non-terminal status. `rejected` counts as open until its escalation window lapses.

### 1.2 Rules
- **Who and when:** the customer of the order, for a seller order that is `delivered`, while `now < delivered_at + RETURN_WINDOW_DAYS` (R-13).
- **One open return per seller order** (RE-1): `uq_return_requests_seller_order_id_open` (partial, `WHERE status IN (<open statuses>)`). After it ends, a new request may cover what is still returnable, inside the window.
- **Quantities:** per order item `1 ≤ q ≤ returnable`, where `returnable = quantity − cancelled_quantity − returned_quantity` (ordering). An item can't be in two returns at once (follows from the one-open rule).
- **One reason per request** (RE-4). Items with different reasons go in separate requests, one after the other.
- **Return fee (R-13):** the current delivery fee of the customer's governorate (`delivery.getGovernorateFees`), snapshotted at request time with the agent share rate (RE-5). Seller-fault reason → the seller pays it; `changed_mind` → it is deducted from the customer's refund. Governorate no longer deliverable → `422 RETURN_PICKUP_UNAVAILABLE`.
- **`changed_mind` must leave something to refund:** items paid amount `≤` return fee → `422 RETURN_AMOUNT_TOO_LOW`.
- **The original delivery fee is never refunded** (RE-7).
- **COD payout details** (R-15): a COD order's request must carry where the refund goes (`mobile_wallet` number or `instapay` address). Kashier orders must not send it. The details are stored encrypted (AES-256-GCM, the S-1 key), travel encrypted in `return.completed` to payments, and are cleared from `return_requests` when the request ends.

## 2. Public API (`index.ts`)

| Method | Caller | Notes |
|---|---|---|
| `getOpenReturnSellerOrderIds(sellerOrderIds) → Set<string>` | finance (holding release, spec 12 §8.3) | Seller orders with an open return (incl. `rejected` inside its escalation window). One query, no lock |
| `getDashboardStats() → { byStatus: Record<open ReturnStatus, number> }` | backoffice (spec 20 §3.2) | One aggregate |

## 3. Use cases

### UC-RE-1 Request a return (customer)
Pre-transaction:
1. `ordering.getReturnableItems(customerId, sellerOrderId)` (spec 09 §8.7) → the seller order (status, `deliveredAt`, payment method, governorate) and per item `returnable` and the **paid unit amounts**. Missing or another customer's → `404 SELLER_ORDER_NOT_FOUND`. Not `delivered` → `422 RETURN_NOT_ALLOWED`. Window over → `422 RETURN_WINDOW_CLOSED`.
2. Check quantities → `422 RETURN_QUANTITY_INVALID` (details per item). Payout details by payment method → `400 VALIDATION_FAILED`.
3. `delivery.getGovernorateFees([governorateId])`, `delivery.getAgentFeeShareRate()` → fee snapshot (§1.2).
4. Estimated refund = Σ paid amounts of the returned quantities (ordering's allocation, spec 09 §8.7) − the fee if `changed_mind`. `≤ 0` → `RETURN_AMOUNT_TOO_LOW`.

One transaction:
5. Insert the request (`requested`, `seller_decision_deadline_at = now() + RETURN_SELLER_DECISION_HOURS`, fee snapshot, fee payer, estimated refund), items, history.
6. `media.claim(photoMediaIds, { purpose: return_photo, ownerUserId }, trx)` + `return_photos`.
7. `23505` on the open-return index → `409 RETURN_ALREADY_OPEN`.
8. Outbox `return.status_changed` (`null → requested`).

### UC-RE-2 Seller decides
Seller guard: the seller of the seller order (any seller status: open orders continue after a suspension, Q-36). Lock the request `FOR UPDATE`.
- **Approve:** `requested → approved` → UC-RE-4.
- **Reject:** `requested → rejected`, `reason`, `escalation_deadline_at = now() + RETURN_ESCALATION_WINDOW_DAYS`.
- Wrong status (including after the deadline job approved it) → `409 RETURN_INVALID_STATUS_TRANSITION`.

### UC-RE-3 Escalate and admin decision
- **Customer escalates** a `rejected` request before `escalation_deadline_at`, with a note → `escalated`. Late → `409 RETURN_ESCALATION_WINDOW_CLOSED`. Talking it through happens in a support ticket (category `return`) if needed; the decision lives here (RE-3).
- **Admin decides** an `escalated` request (or overrides a `requested` one): approve → UC-RE-4; reject → `refused (admin_rejected)`. Final (R-14). Audit row (spec 20).

### UC-RE-4 Approved
In the approving transaction:
- `approved`, `approved_at`.
- `ordering.getReturnLogistics(sellerOrderId)` (read before the transaction) supplies the pickup snapshot (the order's drop-off address = the customer) and the drop-off snapshot (the seller's pickup address).
- Outbox `return.approved` with both snapshots, the items count and the fee snapshot → delivery creates the return shipment (spec 11 §8).

### UC-RE-5 Customer cancels
From `requested` or `approved` (before pickup). Approved → delivery cancels the return shipment from `return.status_changed` (`to = cancelled`); an agent who already picked it up wins the race: the request moves to `picked_up` from the delivery event first, and the cancel answers `409 RETURN_INVALID_STATUS_TRANSITION`. Photos are released (`media.release`), payout details cleared.

### UC-RE-6 Shipment progress (consumer `returns.shipment-updates`)
- `return_shipment.picked_up` → `approved → picked_up`, `agent_id`.
- `return_shipment.delivered` → `picked_up → received`, `received_at`, `inspection_deadline_at = now() + RETURN_INSPECTION_HOURS`.
- `return_shipment.failed` → `approved → pickup_failed` (terminal; nothing moved, no fee charged). Payout details cleared.
- Early events (e.g. `delivered` before `picked_up` is applied) are retried, stale ones are a `warn` no-op (the OR-14 rule).

### UC-RE-7 Complete (seller confirms, the inspection job, or an admin resolving a dispute with "refund")
One transaction, lock order `return_requests` → `orders` → `seller_orders` → `inventory_items` (spec 09 §1.2 extended: nothing locks a return after an order):
1. Lock the request; it must be `received` (or `disputed` for the admin).
2. `ordering.recordReturn({ sellerOrderId, returnId, lines }, trx)` (spec 09 §8.7) → the final amounts: `itemsPaid`, `itemsSubtotal`, `commissionReversed`, `sellerNetReversed`, `platformDiscountReversed`. Ordering checks the quantities again under its locks.
3. `inventory.restock(lines where restock = true, trx)` (spec 07 §8). The seller chooses per item when confirming; the job and an admin restock nothing (RE-6).
4. `refundAmount = itemsPaid − (feePayer = customer ? returnFee : 0)`; `agentFeeShare = round(returnFee × agentShareRate)`.
5. `completed`, `completed_at`. Outbox `return.status_changed` and `return.completed` (amounts, fee, payer, agent, encrypted payout details for COD). Then the payout details are cleared.

### UC-RE-8 Dispute
The seller disputes a `received` request before the inspection deadline (`reason`, optional photos: the seller's own `return_photo` uploads) → `disputed`. An admin resolves it: **refund** → UC-RE-7 (restock nothing; the seller adjusts stock by hand), or **no refund** → `refused (dispute_upheld)`. Final. Audit row.

### UC-RE-9 Jobs (worker, advisory-locked, every `JOB_RETURNS_INTERVAL_MS`)
Candidates read without locks; each request in its own short transaction with `FOR UPDATE SKIP LOCKED` (P5-Q5 pattern):
- `requested` past `seller_decision_deadline_at` → approved (actor `system`, R-14 "silence = approve") → UC-RE-4.
- `rejected` past `escalation_deadline_at` → `refused (seller_rejected)`.
- `received` past `inspection_deadline_at` → UC-RE-7, restocking nothing.

## 4. Endpoints

```ts
interface ReturnDto {
  id: string; returnNumber: string; orderId: string; orderNumber: string; sellerOrderId: string;
  status: ReturnStatus; reason: ReturnReason; description: string | null;
  items: { id: string; orderItemId: string; productName: string; attributes: { attribute: string; value: string }[];
           image: ImageDto | null; quantity: number; paidAmount: string; restock: boolean | null }[];
  photos: ImageDto[];                       // private, presigned (spec 14 ME-1)
  returnFee: string; returnFeePayer: ReturnFeePayer;
  refundAmount: string;                     // estimated until completed, then final
  refund: { status: 'pending' | 'processing' | 'succeeded' | 'manual'; amount: string; refundedAt: string | null } | null;  // payments.getRefundsByReturnIds
  sellerDecisionDeadlineAt: string | null; escalationDeadlineAt: string | null; inspectionDeadlineAt: string | null;
  rejectionReason: string | null; refusalReason: ReturnRefusalReason | null;
  timeline: { status: ReturnStatus; at: string }[];
  createdAt: string;
}
type SellerReturnDto = Omit<ReturnDto, 'refund'>;   // no customer name, phone or address (S-11); the payout method is never shown
interface AdminReturnDto extends ReturnDto {
  customerId: string; sellerId: string; agentId: string | null;
  payoutMethod: RefundPayoutMethod | null;          // the details themselves live in the payments refund queue
  history: { from: ReturnStatus | null; to: ReturnStatus; actorRole: string; actorUserId: string | null; reason: string | null; at: string }[];
}
```

### 4.1 Customer   auth: customer · rate: general
| Endpoint | idem | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /orders/:orderId/seller-orders/:sellerOrderId/returnable-items` | – | – | `200 { windowEndsAt, items: { orderItemId, returnable, paidUnitAmount }[], returnFee }` | `ORDER_NOT_FOUND` 404, `SELLER_ORDER_NOT_FOUND` 404, `RETURN_NOT_ALLOWED` 422, `RETURN_WINDOW_CLOSED` 422, `RETURN_PICKUP_UNAVAILABLE` 422 |
| `POST /returns` | required | `sellerOrderId uuid` · `reason enum(ReturnReason)` · `description opt str(1..1000)` · `items: { orderItemId uuid, quantity int(1..99) }[]` `@ArrayMinSize(1)` `@ArrayMaxSize(50)`, unique items · `photoMediaIds opt uuid[]` `@ArrayMaxSize(4)` · `refundPayout opt { method enum(RefundPayoutMethod), walletNumber phone (mobile_wallet) \| instapayAddress str(3..100) (instapay) }` | `201 ReturnDto` | the above + `RETURN_QUANTITY_INVALID` 422, `RETURN_PHOTOS_REQUIRED` 422, `RETURN_AMOUNT_TOO_LOW` 422, `RETURN_ALREADY_OPEN` 409, `MEDIA_NOT_ATTACHABLE` 422 |
| `GET /returns` | – | whitelist `status` (enum, `eq,in`) · `createdAt` (date, `gte,lte`, sort, default `-createdAt`) | `200 ReturnDto[]` + meta | – |
| `GET /returns/:returnId` | – | – | `200 ReturnDto` | `RETURN_NOT_FOUND` 404 |
| `POST /returns/:returnId/cancel` | – | – | `200 ReturnDto` | `RETURN_NOT_FOUND`, `RETURN_INVALID_STATUS_TRANSITION` 409 |
| `POST /returns/:returnId/escalate` | – | `note str(3..500)` | `200 ReturnDto` | `RETURN_NOT_FOUND`, `RETURN_INVALID_STATUS_TRANSITION`, `RETURN_ESCALATION_WINDOW_CLOSED` 409 |

### 4.2 Seller   auth: seller · rate: general
| Endpoint | idem | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /seller/returns` | – | whitelist `status` (`eq,in`) · `createdAt` (sort, default `-createdAt`) · `sellerDecisionDeadlineAt` (sort: the queue) | `200 SellerReturnDto[]` + meta | – |
| `GET /seller/returns/:returnId` | – | – | `200 SellerReturnDto` | `RETURN_NOT_FOUND` 404 |
| `POST /seller/returns/:returnId/approve` | – | – | `200` | `RETURN_NOT_FOUND`, `RETURN_INVALID_STATUS_TRANSITION` 409 |
| `POST /seller/returns/:returnId/reject` | – | `reason str(3..500)` | `200` | same |
| `POST /seller/returns/:returnId/confirm-receipt` | required | `items: { returnItemId uuid, restock bool }[]` (every item exactly once) | `200` | same + `RETURN_ITEMS_MISMATCH` 422 |
| `POST /seller/returns/:returnId/dispute` | – | `reason str(3..500)` · `photoMediaIds opt uuid[]` (max 4) | `200` | same + `MEDIA_NOT_ATTACHABLE` |

### 4.3 Admin   auth: admin · rate: general
| Endpoint | idem | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /admin/returns` | – | whitelist `status` · `reason` (`eq,in`) · `sellerId` · `customerId` (uuid, `eq`) · `createdAt` (sort, default `-createdAt`) | `200 AdminReturnDto[]` + meta | – |
| `GET /admin/returns/:returnId` | – | – | `200 AdminReturnDto` | `RETURN_NOT_FOUND` |
| `POST /admin/returns/:returnId/decide` | – | `decision enum(approve, reject)` · `note str(3..500)` | `200` | `RETURN_NOT_FOUND`, `RETURN_INVALID_STATUS_TRANSITION` (only `requested` / `escalated`) |
| `POST /admin/returns/:returnId/resolve-dispute` | required | `decision enum(refund, no_refund)` · `note str(3..500)` | `200` | same (only `disputed`) |

## 5. Events
Published:
- `return.status_changed` `{ returnId, returnNumber, orderId, orderNumber, sellerOrderId, customerId, sellerId, from, to, actor }` → realtime, notifications, delivery (`to = cancelled` cancels the return shipment)
- `return.approved` `{ returnId, returnNumber, sellerOrderId, orderId, sellerId, pickup: <customer address snapshot>, dropoff: <seller pickup snapshot + business name>, itemCount, returnFee, agentShareRate }` → delivery
- `return.completed` `{ returnId, sellerOrderId, orderId, customerId, sellerId, paymentMethod, itemsPaid, itemsSubtotal, commissionReversed, sellerNetReversed, platformDiscountReversed, returnFee, returnFeePayer, agentId, agentFeeShare, refundAmount, refundPayoutEncrypted: string | null }` → payments, finance

Consumed (queue `returns.shipment-updates`): `return_shipment.picked_up`, `return_shipment.delivered`, `return_shipment.failed`.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `RETURN_NOT_FOUND` | 404 | Missing, or not the caller's (customer / seller) |
| `RETURN_NOT_ALLOWED` | 422 | The seller order isn't `delivered` |
| `RETURN_WINDOW_CLOSED` | 422 | After `delivered_at + RETURN_WINDOW_DAYS` |
| `RETURN_QUANTITY_INVALID` | 422 | Over the returnable quantity, or an item of another seller order (details per item). Ordering's code (spec 09 OR-28) |
| `RETURN_PHOTOS_REQUIRED` | 422 | A seller-fault reason without a photo |
| `RETURN_AMOUNT_TOO_LOW` | 422 | `changed_mind` where the fee eats the whole refund |
| `RETURN_PICKUP_UNAVAILABLE` | 422 | The customer's governorate is no longer deliverable |
| `RETURN_ALREADY_OPEN` | 409 | Another open return for the seller order |
| `RETURN_INVALID_STATUS_TRANSITION` | 409 | |
| `RETURN_ESCALATION_WINDOW_CLOSED` | 409 | Escalation after `escalation_deadline_at` |
| `RETURN_ITEMS_MISMATCH` | 422 | Receipt confirmation doesn't list each item exactly once |

Config: api `RETURN_WINDOW_DAYS`, `RETURN_SELLER_DECISION_HOURS`, `RETURN_ESCALATION_WINDOW_DAYS`, `RETURN_INSPECTION_HOURS`; worker the same four + `JOB_RETURNS_INTERVAL_MS`, `RETURN_JOBS_BATCH_SIZE`, and the S-1 encryption key (already there). No defaults.

## 7. Decisions (answered 2026-10-20)

The user accepted every recommendation (2026-10-20). The table is kept for the reasoning; the answers are logged in `00-overview.md` §10.11.

| # | Topic | Options / recommendation |
|---|---|---|
| RE-1 | Several returns per seller order | **Rec:** one open return at a time; later requests for what is still returnable while the window is open · or one return per seller order, ever |
| RE-2 | Photos | **Rec:** at least 1 (max 4) for seller-fault reasons, optional for `changed_mind`; private media, visible to the customer, the seller of the order and admins · or always optional |
| RE-3 | Escalation | **Rec:** a `rejected` request can be escalated within 7 days with a note; the admin decides in returns (final); a support ticket is optional for the conversation · or escalation by opening a support ticket that an admin links to the return |
| RE-4 | Reasons per request | **Rec:** one reason per request (the fee payer follows from it) · or a reason per item (mixed payers in one request) |
| RE-5 | Return fee amount | **Rec:** the current delivery fee of the customer's governorate, snapshotted at request time, with the current agent share rate · or a separate return-fee setting |
| RE-6 | Seller inspection after the parcel arrives | **Rec:** the seller confirms (choosing per item whether to restock) or disputes within 48 h; silence = confirmed without restock (the seller can still adjust stock); an admin settles a dispute, refund or no refund, final · or no inspection step: the refund runs when the agent hands the parcel over |
| RE-7 | Original delivery fee | **Rec:** never refunded, even when every item comes back (the delivery happened, and seller-fault pickups are free for the customer) · or refunded when the whole checkout is returned for a seller-fault reason |
| RE-8 | COD payout details | **Rec:** mobile wallet number or InstaPay address, given in the request, stored encrypted, sent encrypted to payments, cleared from returns at the end · or bank account details as a third method |
| RE-9 | Return notifications | **Rec:** in-app + push under `orders`: the seller on a new request, a received parcel and an escalation outcome; the customer on approval (incl. auto-approval), rejection, pickup, completion, refusal and when the refund is paid · or customer notifications only |
| RE-10 | Abuse limits | **Rec:** none beyond the one-open rule and the window in R2; admins see a customer's return history in the admin list (`customerId` filter) · or a cap on returns per customer per month |

### 7.1 Clarifications (R2-P6 plan, approved 2026-10-21)

| # | Clarification | Where |
|---|---|---|
| RE-11 | Coupons come in R2-P7: R2-P6 implements the return amounts and bookings with the discount at zero (no discount columns yet, `platformDiscountReversed` always `"0.00"`, no `platform_promotions` account). R2-P7 adds the discount terms and their tests (spec 09 OR-27, spec 12 FI-16) | §3, §5 |
| RE-12 | Kashier's refund API is verified on its test environment in plan step 7, before UC-PA-6 (spec 10 PA-27); the gateway is written against the documented call first | spec 10 §8.3 |
| RE-13 | The `_manually` payment statuses are converted and dropped in one R2-P6 migration: nothing is in production yet (spec 10 PA-28, database D-23) | spec 10 §8.1 |
| RE-14 | A seller may upload `return_photo` media for a dispute (spec 14 ME-14); returns checks that each photo was uploaded by the caller | UC-RE-8 |
| RE-15 | The dashboard gains the return figures in R2-P6: `returns.byStatus`, `finance.sellerPending`, `finance.customerRefundPayable`, `delivery.returnsInProgress` (spec 20 BO-24) | §2 |
| RE-16 | Notification links: customer `/returns/<returnId>`, seller `/seller/returns/<returnId>`; `refund_issued` links to `/orders/<orderId>` and is sent for every refund reason (spec 13 NO-34) | spec 13 §8.8 |
| RE-17 | The realtime messages of spec 15 §8 (`return.updated`, `shipment.updated` with `kind`, `payment.updated` for refunds) ship in R2-P6 (spec 15 RT-21) | spec 15 §8 |
| RE-18 | Kashier refunds left `pending_manual` from R1 stay manual (`method = manual`); an admin retry hands one to the automated job (spec 10 PA-29) | spec 10 §8.4 |
| RE-19 | Module edges as architecture §14.2: returns → ordering, inventory, payments, delivery, media; finance → returns; backoffice → returns | §1 |
| RE-20 | Order of work: plan §9.1 | plan |
| RE-21 | `return_number` = `R-` + 9 digits from `return_number_seq` (`chk_return_requests_return_number` `^R-[0-9]{9,}$`), like tickets (SU-16) | §1 |
