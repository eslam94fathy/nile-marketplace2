# Spec 08 — cart

Status: **v1.0 APPROVED (2026-10-11).** Approved by the user with the Phase 4 clarifications in §7.1. Changes from now on need explicit approval and a version bump.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

One cart per customer, created lazily on the first add. The cart stores only `variant_id + quantity`. Prices, names and availability are **always read live** (catalog + inventory), never stored.
Tables: `carts`, `cart_items`.
Depends on: `customers` (profile from the JWT `sub`, CT-1), `catalog` (variants), `inventory` (stock), `sellers` (display names).

Limits (DB-Q3): quantity per line **1..99** (a constant that mirrors the DB `CHECK`), max **50** lines (`CART_MAX_LINES`, api env, CT-9).

## 2. Public API (`index.ts`)

| Method | Caller | Notes |
|---|---|---|
| `getLinesForCheckout(customerId, trx) → { variantId, quantity }[]` | ordering | Locks the cart row (`FOR UPDATE`) so two checkouts of the same cart serialise. Lines in cart order (CT-6) |
| `clear(customerId, trx)` | ordering | Deletes all lines |

Both are built and tested in Phase 4; ordering calls them from Phase 5.

## 3. Use cases

### UC-CT-1 View the cart
Load the lines → `catalog.getVariantsForPurchase(ids)` + `inventory.getStockByVariantIds(ids)` + `sellers.getSummaries(sellerIds)` (three batched calls). Each line gets an `issue`, checked in this order:
- `UNAVAILABLE`: `purchasable` is false (variant/product deleted or inactive, or the seller isn't visible: the catalog `seller_active` projection, CT-7).
- `OUT_OF_STOCK`: sellable = 0.
- `INSUFFICIENT_STOCK`: 0 < sellable < quantity (`availableQuantity` shows how many).
- `null`: OK.

Lines are grouped by seller (= the future seller orders). Totals count **only lines without an issue**. Lines with issues are shown, not deleted; the customer fixes or removes them. Checkout fails while any line has an issue. Display rules: CT-6. Edge cases: CT-8.

### UC-CT-2 Add / change / remove
- Every write locks the cart row first (CT-2). Add creates the cart if needed; change / remove / empty never create one.
- Add: if the variant is already in the cart, quantities are **summed** (one line per variant, `uq_cart_items_cart_id_variant_id`). The **resulting** quantity must stay ≤ 99 → `CART_ITEM_QUANTITY_LIMIT` (CT-4).
- Add/change requires the variant to be purchasable → `VARIANT_NOT_PURCHASABLE` (also when decreasing; the customer removes the line instead), and the resulting quantity ≤ sellable → `INSUFFICIENT_STOCK` (a soft check, read without locks; checkout re-checks with a reservation).
- A new line when the cart already has `CART_MAX_LINES` → `CART_LINE_LIMIT_REACHED`.
- No `Idempotency-Key` (CT-5).

## 4. Endpoints   auth: customer · rate: general

```ts
interface CartDto {
  id: string | null;                // null until the first add
  sellers: {
    sellerId: string; businessName: string;
    items: CartItemDto[];
    subtotal: string;               // lines without issue
  }[];
  itemsTotal: string;               // Σ subtotals; delivery fee isn't known until an address is chosen
  itemCount: number;                // Σ quantities of lines without issue
  hasIssues: boolean;
}
interface CartItemDto {
  id: string; variantId: string; productId: string; productName: string; productSlug: string;
  sku: string; attributes: { attribute: string; value: string }[];
  unitPrice: string; quantity: number; lineTotal: string;   // lineTotal = unitPrice × quantity, also on issue lines
  issue: 'UNAVAILABLE' | 'OUT_OF_STOCK' | 'INSUFFICIENT_STOCK' | null;
  availableQuantity: number;        // 0 when UNAVAILABLE, else min(sellable, 99)
}
```

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `GET /cart` | – | `200 CartDto` | – |
| `POST /cart/items` | `variantId uuid` · `quantity int(1..99)` | `201 CartDto` (also when added to an existing line) | `VARIANT_NOT_PURCHASABLE` 422, `INSUFFICIENT_STOCK` 409, `CART_ITEM_QUANTITY_LIMIT` 422, `CART_LINE_LIMIT_REACHED` 422 |
| `PATCH /cart/items/:itemId` | `quantity int(1..99)` | `200 CartDto` | `CART_ITEM_NOT_FOUND` 404, `VARIANT_NOT_PURCHASABLE`, `INSUFFICIENT_STOCK` |
| `DELETE /cart/items/:itemId` | – | `204` | `CART_ITEM_NOT_FOUND` 404 |
| `DELETE /cart` | – | `204` (empties the cart; also with no cart) | – |

`DELETE /cart` is new (not in overview §6): it's a convenience for the app, with no business rule attached.

## 5. Events
None published, none consumed.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `CART_ITEM_NOT_FOUND` | 404 | Missing or another customer's line (or no cart yet) |
| `VARIANT_NOT_PURCHASABLE` | 422 | Variant/product inactive or deleted, seller hidden, or unknown variant |
| `CART_ITEM_QUANTITY_LIMIT` | 422 | Line quantity would exceed 99 |
| `CART_LINE_LIMIT_REACHED` | 422 | A new line beyond `CART_MAX_LINES` |
| `INSUFFICIENT_STOCK` | 409 | Owned by inventory (spec 07 §6, CT-3); details `[{ field: 'variantId', value, constraint: 'available', message: 'available: <n>' }]` |

## 7. Open questions
None.

### 7.1 Clarifications (v1.0, Phase 4 plan, 2026-10-11)

| # | Clarification | Where |
|---|---|---|
| CT-1 | Cart depends on customers to resolve the JWT `sub` to a `customerId` (`getCustomerIdByUserId`); the edge `cart → customers` is added to architecture §2 (A-4, v1.6) (P4-Q2) | §1 |
| CT-2 | Every write starts by locking the cart row. Add creates and locks in one statement: `INSERT INTO carts (customer_id) VALUES (?) ON CONFLICT (customer_id) DO UPDATE SET updated_at = now() RETURNING id`. Change / remove / empty use `SELECT … FOR UPDATE` and never create a cart. Purchasability and stock are then read in the same transaction without locks. `carts` is always locked first, as in checkout, so there's no lock cycle (P4-Q3) | UC-CT-2 |
| CT-3 | `INSUFFICIENT_STOCK` is inventory's code and factory, exported from Phase 4 (spec 07 v1.1); cart throws it with one detail (P4-Q4) | §6 |
| CT-4 | Add checks the resulting line quantity (existing + added) against 99 and sellable; change checks the new absolute quantity; a non-purchasable variant fails `422` even when decreasing (P4-Q5) | UC-CT-2 |
| CT-5 | No `Idempotency-Key` on `POST /cart/items`: an add has no money or stock effect (CLAUDE.md §10). A retried add is summed, which the customer sees and fixes, and checkout needs `expectedTotal` (S-8) (P4-Q6) | UC-CT-2 |
| CT-6 | Lines sort by `created_at, id`; seller groups sort by their earliest line. Every line shows `unitPrice` and `lineTotal` (`Money`), but issue lines are left out of `subtotal`, `itemsTotal` and `itemCount`; a group whose lines all have issues still shows with `subtotal` `"0.00"`. `availableQuantity` is 0 for `UNAVAILABLE`, else `min(sellable, 99)`. `POST /cart/items` returns `201` also when it added to an existing line (P4-Q7) | UC-CT-1, §4 |
| CT-7 | "Seller not visible" comes from `purchasable` alone (the `seller_active` projection, updated by `catalog.listing-projections` within about a second). Cart calls `sellers.getSummaries` only for display names; checkout re-checks the live seller status (spec 09 step 4) (P4-Q8) | UC-CT-1 |
| CT-8 | A customer-role token with no customer profile is an invariant violation → non-operational `500`. A line whose variant `getVariantsForPurchase` doesn't return (impossible: variants are soft-deleted, FK `RESTRICT`) is left out of the view and logged at `error`. An empty or missing cart returns `id: null`, `sellers: []`, `itemsTotal` `"0.00"`, `itemCount` 0, `hasIssues` false, and `GET` never creates a row (P4-Q9) | UC-CT-1 |
| CT-9 | `CART_MAX_LINES` (50) is in the api env schema only, with no default. The 99 per line is a constant, because it mirrors the DB `CHECK` (P4-Q10) | §1 |
