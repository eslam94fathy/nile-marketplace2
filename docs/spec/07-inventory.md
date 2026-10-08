# Spec 07 — inventory

Status: **DRAFT v0.1 (2026-10-08), under review.** [PROPOSED].
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Stock per variant: on hand, reserved, reservations per order line, and the audit trail of every movement.
Tables: `inventory_items`, `inventory_reservations`, `inventory_movements`.
Depends on: nothing. It's called by `catalog` (create/adjust/read) and `ordering` (reserve/release/commit). **It has no HTTP endpoints**: the seller-facing stock routes live in `catalog` (spec 06 §4.3), because ownership (variant → seller) is known there.

Enums: `ReservationStatus`: `active, committed, released` · `MovementType`: `seller_adjustment, reserve, release, commit`.

Sellable = `on_hand − reserved`.

## 2. Public API (`index.ts`)

All writes take `trx`, write an `inventory_movements` row per changed item, and emit `inventory.stock_status_changed` when sellable crosses 0 for that item (same `trx`, outbox).

| Method | Caller | Behaviour |
|---|---|---|
| `createItem(variantId, initialStock, actorUserId, trx)` | catalog | Insert `inventory_items` (`on_hand = initialStock, reserved = 0`) + a `seller_adjustment` movement if > 0 |
| `adjust(variantId, delta, actorUserId, trx) → StockDto` | catalog | `UPDATE … SET on_hand = on_hand + :d WHERE variant_id = ? AND on_hand + :d >= reserved AND on_hand + :d >= 0 RETURNING …`. 0 rows → `STOCK_ADJUSTMENT_INVALID` |
| `getStockByVariantIds(variantIds, trx?) → StockDto[]` | catalog, cart, ordering | One `variant_id = ANY(?)` query. `{ variantId, onHand, reserved, sellable }` |
| `reserve(lines: { variantId, orderItemId, quantity }[], trx)` | ordering (checkout) | See UC-IN-1 |
| `release(lines: { orderItemId, quantity }[], reason, trx)` | ordering | Releases `quantity` (partial or full). See UC-IN-2 |
| `commit(orderItemIds, trx)` | ordering (delivered) | See UC-IN-3 |
| `listMovements(variantId, page) → Page<MovementDto>` | catalog | Seller stock history |

## 3. Use cases

### UC-IN-1 Reserve (checkout)
1. Resolve the items for all `variantId`s in one query, **sorted by `inventory_items.id`** (lock order, architecture §3.1).
2. Per line, in that order: `UPDATE inventory_items SET reserved = reserved + :q, updated_at = now() WHERE id = :id AND on_hand - reserved >= :q RETURNING on_hand, reserved`.
3. Lines that update 0 rows are **collected** (the loop continues so the client gets every short line at once). If any are short → throw `INSUFFICIENT_STOCK` with `details: [{ field: 'variantId', value, constraint: 'available', message: 'available: <n>' }]`. The caller's transaction rolls back.
4. Insert one `inventory_reservations` row per line (`status = active`) as a single multi-row insert, plus `reserve` movements.

### UC-IN-2 Release
- Lock the reservation (`FOR UPDATE`). It must be `active` and `quantity >= q`.
- `reserved −= q` on the item. The reservation's `quantity −= q`. If it reaches 0 → `status = released`.
- Used for: seller item cancellation (partial), seller order cancellation, customer cancellation, acceptance timeout, payment expiry/failure, return received.
- Releasing an already released reservation is a no-op (consumer replays are harmless).

### UC-IN-3 Commit (delivered)
- For each `active` reservation: `on_hand −= quantity`, `reserved −= quantity`, `status = committed`, `commit` movement.
- Committing doesn't change sellable stock, so it never emits `inventory.stock_status_changed`.

## 4. Endpoints
None (see §1).

## 5. Events
Published: `inventory.stock_status_changed`.
Consumed: none.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `INSUFFICIENT_STOCK` | 409 | Reserve short on one or more variants (details per variant) |
| `STOCK_ADJUSTMENT_INVALID` | 422 | Adjustment would make `on_hand` negative or below `reserved` |
| `INVENTORY_ITEM_NOT_FOUND` | 500 (internal) | A variant has no stock row: a bug, never expected |

## 7. Open questions
None.
