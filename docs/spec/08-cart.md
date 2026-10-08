# Spec 08 — cart

Status: **DRAFT v0.1 (2026-10-08), under review.** [PROPOSED].
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

One cart per customer, created lazily on the first add. The cart stores only `variant_id + quantity`. Prices, names and availability are **always read live** (catalog + inventory), never stored.
Tables: `carts`, `cart_items`.
Depends on: `customers` (profile), `catalog` (variants), `inventory` (stock), `sellers` (display names).

Limits (DB-Q3): quantity per line **1..99**, max **50** lines (`CART_MAX_LINES`, env).

## 2. Public API (`index.ts`)

| Method | Caller | Notes |
|---|---|---|
| `getLinesForCheckout(customerId, trx) → { variantId, quantity }[]` | ordering | Locks the cart row (`FOR UPDATE`) so two checkouts of the same cart serialise |
| `clear(customerId, trx)` | ordering | Deletes all lines |

## 3. Use cases

### UC-CT-1 View the cart
Load the lines → `catalog.getVariantsForPurchase(ids)` + `inventory.getStockByVariantIds(ids)` + `sellers.getSummaries(sellerIds)` (three batched calls). Each line gets an `issue`:
- `UNAVAILABLE`: variant/product deleted or inactive, or the seller isn't visible.
- `OUT_OF_STOCK`: sellable = 0.
- `INSUFFICIENT_STOCK`: 0 < sellable < quantity (`availableQuantity` shows how many).
- `null`: OK.

Lines are grouped by seller (= the future seller orders). Totals count **only lines without an issue**. Lines with issues are shown, not deleted; the customer fixes or removes them. Checkout fails while any line has an issue.

### UC-CT-2 Add / change / remove
- Add: if the variant is already in the cart, quantities are **summed** (one line per variant, `uq_cart_items_cart_id_variant_id`). The total must stay ≤ 99 → `CART_ITEM_QUANTITY_LIMIT`.
- Add/change requires the variant to be purchasable → `VARIANT_NOT_PURCHASABLE`, and `quantity ≤ sellable` → `INSUFFICIENT_STOCK` (a soft check; checkout re-checks with a reservation).
- A new line when the cart already has 50 → `CART_LINE_LIMIT_REACHED`.

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
  unitPrice: string; quantity: number; lineTotal: string;
  issue: 'UNAVAILABLE' | 'OUT_OF_STOCK' | 'INSUFFICIENT_STOCK' | null;
  availableQuantity: number;        // min(sellable, 99)
}
```

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `GET /cart` | – | `200 CartDto` | – |
| `POST /cart/items` | `variantId uuid` · `quantity int(1..99)` | `201 CartDto` | `VARIANT_NOT_PURCHASABLE` 422, `INSUFFICIENT_STOCK` 409, `CART_ITEM_QUANTITY_LIMIT` 422, `CART_LINE_LIMIT_REACHED` 422 |
| `PATCH /cart/items/:itemId` | `quantity int(1..99)` | `200 CartDto` | `CART_ITEM_NOT_FOUND` 404, `VARIANT_NOT_PURCHASABLE`, `INSUFFICIENT_STOCK` |
| `DELETE /cart/items/:itemId` | – | `204` | `CART_ITEM_NOT_FOUND` 404 |
| `DELETE /cart` | – | `204` (empties the cart) | – |

`DELETE /cart` is new (not in overview §6): it's a convenience for the app, with no business rule attached.

## 5. Events
None published, none consumed.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `CART_ITEM_NOT_FOUND` | 404 | Missing or another customer's line |
| `VARIANT_NOT_PURCHASABLE` | 422 | Variant/product inactive or deleted, seller hidden, or unknown variant |
| `CART_ITEM_QUANTITY_LIMIT` | 422 | Line quantity would exceed 99 |
| `CART_LINE_LIMIT_REACHED` | 422 | 51st line |
| `INSUFFICIENT_STOCK` | 409 | From inventory semantics (same code) |

## 7. Open questions
None.
