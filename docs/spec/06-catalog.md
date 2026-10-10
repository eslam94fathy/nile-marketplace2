# Spec 06 — catalog

Status: **v1.1 APPROVED (2026-10-10).** v1.0: approved with the Phase 3 clarifications in §7.1. v1.1: an active category always has an active parent (CA-13); attribute writes lock the whole subtree (CA-2). v1.2: product writes hold their category `FOR SHARE` (CA-2). Changes from now on need explicit approval and a version bump.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Category tree (max depth 3), admin-defined attributes + options (inherited by descendants), seller products and variants, public browse/search, and the seller-facing stock endpoints (ownership lives here; stock itself is owned by `inventory`).
Tables: `categories`, `category_attributes`, `category_attribute_options`, `products` (soft delete), `product_variants` (soft delete), `variant_attribute_values`.
Depends on: `sellers` (seller guard, display names, projection re-read), `inventory` (create stock row, adjust, read stock).

Enums: `ProductStatus`: `draft, active, inactive` · `VariantStatus`: `active, inactive`.

Limits (constants in `constants.ts`; change = code review): effective attributes per category **≤ 5**, options per attribute **≤ 100**, variants per product **≤ 100**, children per category **≤ 100**.

**Effective attributes** of a category = its own attributes + those of all its ancestors (Q-30), ordered by depth, then `sort_order`.

## 2. Public API (`index.ts`)

| Method | Used by | Notes |
|---|---|---|
| `getVariantsForPurchase(variantIds, trx?) → PurchasableVariant[]` | cart, ordering | One query. `{ variantId, productId, productName, productSlug, sku, price, sellerId, attributes: { attribute: string; value: string }[], purchasable: boolean }`. `purchasable` = variant `active` and not deleted, product `active` + `seller_active` and not deleted |

## 3. Use cases

### UC-CA-1 Admin manages the category tree
- Create: `depth = parent.depth + 1` (root = 1). Depth 4 → `CATEGORY_MAX_DEPTH_EXCEEDED`. `slug` defaults to kebab-case of `name`; a taken slug → `CATEGORY_SLUG_TAKEN` (the admin then sends one). If kebab-casing leaves nothing → `CATEGORY_SLUG_REQUIRED` (CA-10). Duplicate sibling name → `CATEGORY_NAME_TAKEN`.
- Every category, attribute and option write first locks the affected category row (the parent on create) `FOR UPDATE` (CA-2).
- Update: `name`, `slug`, `sortOrder`, `isActive`. **Moving** a category (changing `parentId`) isn't supported in R1.
- Deactivate (`isActive = false`) only if it has no active child and no non-deleted product → else `CATEGORY_IN_USE`. Categories are never deleted.
- An active category always has an active parent (CA-13): activating a category whose parent is inactive, or creating one under an inactive parent → `CATEGORY_PARENT_INACTIVE`. A branch is re-activated top-down.
- Every change deletes the category-tree cache key after commit.

### UC-CA-2 Admin manages attributes and options
- Add an attribute: the `code` must not exist on the category, any ancestor, or any descendant → `ATTRIBUTE_CODE_CONFLICT`. Allowed only while the category's **subtree has no non-deleted product** → `CATEGORY_HAS_PRODUCTS` (S-5). Over the effective-attribute limit → `ATTRIBUTE_LIMIT_REACHED`.
- Update an attribute: `name`, `sortOrder`. `code` is immutable (it's the public filter key).
- Delete an attribute: only when the subtree has no product (deleted ones included, since `variant_attribute_values` still points at it) → `ATTRIBUTE_IN_USE`. Its options are deleted first, in the same transaction (explicit deletes, no `CASCADE`, CA-11).
- Options: add any time (a new choice doesn't invalidate existing variants). `code` unique per attribute → `OPTION_CODE_TAKEN`. Update `value`, `sortOrder`. Delete only if no variant (deleted ones included) uses it → `OPTION_IN_USE`.

### UC-CA-3 Seller manages products
Guard on **every** seller write: `sellers.getSellerByUserId(userId, { trx, lockShared: true })` inside the write transaction → `status = approved`, else `403 SELLER_NOT_APPROVED` (CA-3). Reads (including stock history) are allowed in any seller status.
Every product or variant write locks the product row `FOR UPDATE` before its checks and the projection recompute; a product create or category change holds the category `FOR SHARE` (CA-2).
- Create: `status = draft`, `seller_active = true`, `min_price/max_price = null`, `in_stock = false`. The category must exist and be active → `CATEGORY_NOT_FOUND` (422). `slug` = kebab(name) + `-` + 6 random base36 chars (`product-` + 6 chars when kebab-casing leaves nothing, CA-10), **immutable** (stable links even after a rename).
- Update: `name`, `description`, `categoryId`. The category can change only while the product has **no non-deleted variant** → `PRODUCT_CATEGORY_LOCKED`.
- Activate (`draft|inactive → active`): needs ≥1 active variant → `PRODUCT_HAS_NO_ACTIVE_VARIANT`. Sets `published_at` the first time.
- Deactivate (`active → inactive`).
- Delete (soft): sets `deleted_at` on the product and all its variants in one transaction. Carts show the lines as unavailable; orders keep their snapshots.
- When the last active variant of an `active` product is deactivated or deleted, the product moves to `inactive` in the same transaction (overview §4.2).

### UC-CA-4 Seller manages variants
- Create: `optionIds` must contain **exactly one option for each effective attribute** of the product's category → `VARIANT_OPTIONS_INVALID` (with details). Category without attributes → `optionIds = []`, only one variant allowed, `is_default = true` (SD-7) → `DEFAULT_VARIANT_EXISTS`.
- `option_signature` = SHA-256 of the sorted option ids (empty string for the default variant). Duplicate combination → `VARIANT_COMBINATION_EXISTS`. SKU unique per seller, case-insensitive → `SKU_TAKEN`.
- One transaction: insert the variant + its `variant_attribute_values` + `inventory.createItem(variantId, initialStock)`, recompute `min_price`/`max_price` and `in_stock` of the product.
- Update: `sku`, `price`, `compareAtPrice` (nullable), `status`. Options can't change (delete and recreate instead). Recompute the product projections in the same transaction.
- Delete: soft, same recompute.
- Price changes don't touch existing orders (snapshots). Carts show the current price.

### UC-CA-5 Seller adjusts stock (S-6)
Stock changes are **deltas**, not absolute values, because `on_hand` still includes parcels that are picked up but not yet delivered (they're committed on `delivered`, overview §4.5). An absolute "set to N" after a shelf count would double-count them.
- Ownership: the variant belongs to the seller (not deleted).
- `inventory.adjust(variantId, delta, actorUserId, trx)`: conditional update `WHERE on_hand + :delta >= reserved AND on_hand + :delta >= 0`. 0 rows → `STOCK_ADJUSTMENT_INVALID`.
- `products.in_stock` follows through the `inventory.stock_status_changed` consumer (UC-CA-7), not in this transaction.

### UC-CA-6 Public browse & search (architecture §9)
- Only visible products (VIS: `status = active AND seller_active AND deleted_at IS NULL`). Hidden/deleted → `404 PRODUCT_NOT_FOUND`.
- `categoryId` filter includes descendants (ids from the cached tree).
- `q`: `search_vector @@ websearch_to_tsquery('english', q) OR name % q` (pg_trgm, default similarity threshold). Relevance = `round((ts_rank(search_vector, query) + similarity(name, q))::numeric, 6)`, carried in the cursor as a string so keyset paging is exact (CA-6).
- `attr.*` filters: all of them must hold on **the same** active, non-deleted variant (one `EXISTS` over the product's variants carrying every condition). They require `categoryId`; codes resolve against the attributes of that category, its ancestors and its descendants, and an option code may map to several option ids (CA-5).

### UC-CA-7 Listing projections (event consumers)
- `seller.approved` / `seller.suspended` → `sellers.getStatuses([sellerId])` → `UPDATE products SET seller_active = (status = 'approved'), updated_at = now() WHERE seller_id = ? AND seller_active <> ? RETURNING id`. Delete the product-detail cache keys of the returned ids (CA-8).
- `inventory.stock_status_changed` → find the product of the variant (ignored if deleted) → lock it → `inventory.getStockByVariantIds(active variant ids)` → `in_stock = any sellable > 0` → delete its detail cache key. Always recomputed from current stock, so event order doesn't matter (CA-9).

## 4. Endpoints

### 4.1 Public   auth: public · rate: general

#### `GET /categories`
`200 CategoryNodeDto[]` (active only, cached):
```ts
interface CategoryNodeDto { id: string; name: string; slug: string; sortOrder: number; children: CategoryNodeDto[] }
```

#### `GET /categories/:categoryId/attributes`
`200 EffectiveAttributeDto[]`. Errors: `CATEGORY_NOT_FOUND` 404 (missing or inactive).
```ts
interface EffectiveAttributeDto {
  id: string; code: string; name: string; sortOrder: number;
  definedOnCategoryId: string;           // the category (self or ancestor) that owns it
  options: { id: string; code: string; value: string; sortOrder: number }[];
}
```

#### `GET /products`
Query DTO:

| param | rules |
|---|---|
| q | `opt str(2..100)` |
| limit, cursor, sort | §5 of conventions |

Filter whitelist:

| apiField | column | type | ops | sort |
|---|---|---|---|---|
| categoryId | `category_id` (+ descendants) | uuid | `eq` | – |
| price | `min_price` | money | `gte, lte` | – |
| minPrice | `min_price` | money | – | yes |
| publishedAt | `published_at` | – | – | yes (CA-7) |
| relevance | computed | – | – | yes (only with `q`) |
| inStock | `in_stock` | boolean | `eq` | – |
| sellerId | `seller_id` | uuid | `eq` | – |
| `attr.<code>` | same-variant `EXISTS` (UC-CA-6, CA-5); needs `categoryId` | option codes of that attribute | `in` (max 20 values) | – |

- Max 5 `attr.*` filters. An unknown attribute code or option code → `400 INVALID_QUERY`.
- `attr.*` without `categoryId` → `400 INVALID_QUERY`.
- Default sort: `-relevance` when `q` is present, else `-publishedAt`. `sort=relevance` without `q` → `400 INVALID_QUERY`.

`200 ProductListItemDto[]` + meta:
```ts
interface ProductListItemDto {
  id: string; slug: string; name: string;
  minPrice: string; maxPrice: string; inStock: boolean;
  category: { id: string; name: string; slug: string };
  seller: { id: string; businessName: string };   // one batched sellers.getSummaries call
  publishedAt: string;
}
```

#### `GET /products/:idOrSlug`
`idOrSlug`: a UUID v7 or a `slug(1..220)`. `200 ProductDetailDto` (cache-aside, short TTL). Errors: `PRODUCT_NOT_FOUND` 404.
```ts
interface ProductDetailDto {
  id: string; slug: string; name: string; description: string;
  category: { id: string; name: string; slug: string; path: { id: string; name: string; slug: string }[] };
  seller: { id: string; businessName: string };
  minPrice: string; maxPrice: string; inStock: boolean;
  attributes: { code: string; name: string; options: { code: string; value: string }[] }[]; // only options used by active variants
  variants: {
    id: string; sku: string; price: string; compareAtPrice: string | null;
    options: { attributeCode: string; optionCode: string; value: string }[];
    inStock: boolean;
    availableQuantity: number;     // min(sellable, 99). Read live from inventory, never cached
  }[];                             // active variants only
  publishedAt: string;
}
```

### 4.2 Admin   auth: admin · rate: general

```ts
interface AdminCategoryNodeDto {
  id: string; parentId: string | null; name: string; slug: string; depth: number; sortOrder: number; isActive: boolean;
  attributes: { id: string; code: string; name: string; sortOrder: number;
                options: { id: string; code: string; value: string; sortOrder: number }[] }[];  // own only
  children: AdminCategoryNodeDto[];
}
```

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/categories` | – | `200 AdminCategoryNodeDto[]` (incl. inactive) | – |
| `POST /admin/categories` | `parentId opt nullable uuid` · `name str(1..100)` · `slug opt slug(1..120)` · `sortOrder int(0..10000)` | `201 AdminCategoryNodeDto` | `CATEGORY_NOT_FOUND` 422 (parent), `CATEGORY_MAX_DEPTH_EXCEEDED` 422, `CATEGORY_NAME_TAKEN` 409, `CATEGORY_SLUG_TAKEN` 409, `CATEGORY_SLUG_REQUIRED` 422, `CATEGORY_PARENT_INACTIVE` 409, `CATEGORY_CHILD_LIMIT_REACHED` 422 |
| `PATCH /admin/categories/:categoryId` | `name opt` · `slug opt` · `sortOrder opt` · `isActive opt bool` | `200` | `CATEGORY_NOT_FOUND` 404, `CATEGORY_NAME_TAKEN`, `CATEGORY_SLUG_TAKEN`, `CATEGORY_IN_USE` 409, `CATEGORY_PARENT_INACTIVE` 409 |
| `POST /admin/categories/:categoryId/attributes` | `name str(1..60)` · `code slug(1..60)` · `sortOrder int(0..10000)` | `201` attribute | `CATEGORY_NOT_FOUND` 404, `ATTRIBUTE_CODE_CONFLICT` 409, `CATEGORY_HAS_PRODUCTS` 409, `ATTRIBUTE_LIMIT_REACHED` 422 |
| `PATCH /admin/attributes/:attributeId` | `name opt str(1..60)` · `sortOrder opt int(0..10000)` | `200` | `ATTRIBUTE_NOT_FOUND` 404 |
| `DELETE /admin/attributes/:attributeId` | – | `204` | `ATTRIBUTE_NOT_FOUND` 404, `ATTRIBUTE_IN_USE` 409 |
| `POST /admin/attributes/:attributeId/options` | `value str(1..60)` · `code slug(1..60)` · `sortOrder int(0..10000)` | `201` option | `ATTRIBUTE_NOT_FOUND` 404, `OPTION_CODE_TAKEN` 409, `OPTION_LIMIT_REACHED` 422 |
| `PATCH /admin/options/:optionId` | `value opt str(1..60)` · `sortOrder opt int(0..10000)` | `200` | `OPTION_NOT_FOUND` 404 |
| `DELETE /admin/options/:optionId` | – | `204` | `OPTION_NOT_FOUND` 404, `OPTION_IN_USE` 409 |

### 4.3 Seller   auth: seller · rate: general

```ts
interface SellerVariantDto {
  id: string; sku: string; price: string; compareAtPrice: string | null; status: VariantStatus; isDefault: boolean;
  options: { attributeId: string; attributeCode: string; optionId: string; optionCode: string; value: string }[];
  stock: { onHand: number; reserved: number; sellable: number };
  createdAt: string; updatedAt: string;
}
interface SellerProductDto {
  id: string; slug: string; name: string; description: string; categoryId: string;
  status: ProductStatus; visible: boolean;    // = VIS (false while the seller is suspended)
  minPrice: string | null; maxPrice: string | null; inStock: boolean;
  publishedAt: string | null; createdAt: string; updatedAt: string;
}
interface SellerProductDetailDto extends SellerProductDto { variants: SellerVariantDto[] }
```

`GET /seller/products`. Whitelist: `status` (enum, `eq,in`) · `categoryId` (uuid, `eq`) · `name` (text, `like`) · `createdAt` (date, `gte,lte`, sort: yes, default `-createdAt`). → `200 SellerProductDto[]` + meta.

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `POST /seller/products` | `categoryId uuid` · `name str(2..200)` · `description str(1..5000)` | `201 SellerProductDetailDto` | `SELLER_NOT_APPROVED` 403, `CATEGORY_NOT_FOUND` 422 |
| `GET /seller/products/:productId` | – | `200 SellerProductDetailDto` | `PRODUCT_NOT_FOUND` 404 |
| `PATCH /seller/products/:productId` | `name opt` · `description opt` · `categoryId opt uuid` | `200` | `PRODUCT_NOT_FOUND`, `SELLER_NOT_APPROVED`, `CATEGORY_NOT_FOUND` 422, `PRODUCT_CATEGORY_LOCKED` 409 |
| `POST /seller/products/:productId/activate` | – | `200` | `PRODUCT_NOT_FOUND`, `SELLER_NOT_APPROVED`, `PRODUCT_INVALID_STATUS_TRANSITION` 409, `PRODUCT_HAS_NO_ACTIVE_VARIANT` 409 |
| `POST /seller/products/:productId/deactivate` | – | `200` | `PRODUCT_NOT_FOUND`, `SELLER_NOT_APPROVED`, `PRODUCT_INVALID_STATUS_TRANSITION` |
| `DELETE /seller/products/:productId` | – | `204` | `PRODUCT_NOT_FOUND`, `SELLER_NOT_APPROVED` |
| `POST /seller/products/:productId/variants` | see below | `201 SellerVariantDto` | `PRODUCT_NOT_FOUND`, `SELLER_NOT_APPROVED`, `VARIANT_OPTIONS_INVALID` 422, `DEFAULT_VARIANT_EXISTS` 409, `VARIANT_COMBINATION_EXISTS` 409, `SKU_TAKEN` 409, `VARIANT_LIMIT_REACHED` 422 |
| `PATCH /seller/products/:productId/variants/:variantId` | `sku opt` · `price opt money` · `compareAtPrice opt nullable money` · `status opt enum(VariantStatus)` | `200 SellerVariantDto` | `VARIANT_NOT_FOUND` 404, `SELLER_NOT_APPROVED`, `SKU_TAKEN`, `COMPARE_AT_PRICE_INVALID` 422 |
| `DELETE /seller/products/:productId/variants/:variantId` | – | `204` | `VARIANT_NOT_FOUND`, `SELLER_NOT_APPROVED` |

Create variant body (`CreateVariantDto`):

| field | rules |
|---|---|
| sku | `str(1..64)`, `^[A-Za-z0-9._-]+$` |
| price | `money`, > 0 |
| compareAtPrice | `opt nullable money`; must be > `price` → `COMPARE_AT_PRICE_INVALID` |
| optionIds | `uuid[]`, `@ArrayMaxSize(5)`, `@ArrayUnique` |
| initialStock | `int(0..100000)` |
| status | `enum(VariantStatus)` |

#### Stock (S-6)
| Endpoint | idem | Body | Success | Errors |
|---|---|---|---|---|
| `POST /seller/variants/:variantId/stock-adjustments` | required | `delta int(-100000..100000)`, ≠ 0 | `200 { variantId, onHand, reserved, sellable }` | `VARIANT_NOT_FOUND` 404, `SELLER_NOT_APPROVED`, `STOCK_ADJUSTMENT_INVALID` 422 |
| `GET /seller/variants/:variantId/stock-movements` | – | – | `200 { id, type, quantityDelta, onHandAfter, reservedAfter, referenceType, referenceId, createdAt }[]` + meta (sort `-createdAt` only) | `VARIANT_NOT_FOUND` |

This replaces overview §6 `PATCH /seller/variants/:id/stock` (S-6).

## 5. Events
Published: none in R1.
Consumed: `seller.approved`, `seller.suspended`, `inventory.stock_status_changed` (queue `catalog.listing-projections`).

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `CATEGORY_NOT_FOUND` | 404 / 422 | 404 in the path, 422 when referenced in a body |
| `CATEGORY_MAX_DEPTH_EXCEEDED` | 422 | Depth > 3 |
| `CATEGORY_NAME_TAKEN` | 409 | `uq_categories_parent_id_name_lower` |
| `CATEGORY_SLUG_TAKEN` | 409 | `uq_categories_slug` |
| `CATEGORY_SLUG_REQUIRED` | 422 | No `slug` sent and the name kebab-cases to nothing (CA-10) |
| `CATEGORY_CHILD_LIMIT_REACHED` | 422 | > 100 children |
| `CATEGORY_IN_USE` | 409 | Deactivating with active children or products |
| `CATEGORY_PARENT_INACTIVE` | 409 | Activating, or creating, a category under an inactive parent (CA-13) |
| `CATEGORY_HAS_PRODUCTS` | 409 | Adding an attribute to a subtree that has products (S-5) |
| `ATTRIBUTE_NOT_FOUND` | 404 | |
| `ATTRIBUTE_CODE_CONFLICT` | 409 | Code exists on the category, an ancestor, or a descendant |
| `ATTRIBUTE_LIMIT_REACHED` | 422 | > 5 effective attributes |
| `ATTRIBUTE_IN_USE` | 409 | Delete with products in the subtree, or `fk_variant_attribute_values_attribute_id` (`23001`, CA-11) |
| `OPTION_NOT_FOUND` | 404 | |
| `OPTION_CODE_TAKEN` | 409 | `uq_category_attribute_options_attribute_id_code` |
| `OPTION_LIMIT_REACHED` | 422 | > 100 options |
| `OPTION_IN_USE` | 409 | Delete an option used by a variant, or `fk_variant_attribute_values_option_id` (`23001`, CA-11) |
| `PRODUCT_NOT_FOUND` | 404 | Missing, deleted, not visible (public), or another seller's |
| `PRODUCT_INVALID_STATUS_TRANSITION` | 409 | |
| `PRODUCT_HAS_NO_ACTIVE_VARIANT` | 409 | Activate without an active variant |
| `PRODUCT_CATEGORY_LOCKED` | 409 | Change category while variants exist |
| `VARIANT_NOT_FOUND` | 404 | |
| `VARIANT_OPTIONS_INVALID` | 422 | Options don't match the effective attributes |
| `DEFAULT_VARIANT_EXISTS` | 409 | Second variant in a category without attributes |
| `VARIANT_COMBINATION_EXISTS` | 409 | `uq_product_variants_product_id_option_signature` |
| `VARIANT_LIMIT_REACHED` | 422 | > 100 variants |
| `SKU_TAKEN` | 409 | `uq_product_variants_seller_id_sku_lower` |
| `COMPARE_AT_PRICE_INVALID` | 422 | `compareAtPrice <= price` |
| `STOCK_ADJUSTMENT_INVALID` | 422 | Result would be negative or below `reserved` |

## 7. Decisions (answered 2026-10-08, `00-overview.md` §9.1). No open questions.
- **S-5** Adding an attribute to a subtree with products is blocked.
- **S-6** Stock changes are deltas (stock-adjustments route).
- **S-17** All product writes require an `approved` seller.

### 7.1 Clarifications (v1.0, Phase 3 plan, 2026-10-10)

| # | Clarification | Where |
|---|---|---|
| CA-1 | `inventory_reservations` and checkout reservations land in Phase 5; nothing in this spec depends on them before then (P3-Q2) | §1 |
| CA-2 | Product/variant writes and the `in_stock` consumer lock the product row first. Category create locks the parent, category update the category itself, option add the attribute row. Attribute add/delete lock the category's **whole subtree** in id order (v1.1): an ancestor's subtree contains the descendant, so writes along one lineage serialise, which covers code uniqueness, the effective-attribute limit (checked against the largest count in the subtree) and "no products in the subtree". Product create, and a product's category change, hold the category row `FOR SHARE` until commit (v1.2): a concurrent deactivation or attribute add (both `FOR UPDATE`) waits for the product write and then sees the product. Lock order is seller (`FOR SHARE`) → product → category / inventory item (P3-Q3) | UC-CA-1…4 |
| CA-3 | The seller guard reads the seller `FOR SHARE` inside the write transaction (spec 05 SE-4, P3-Q4) | UC-CA-3 |
| CA-4 | The list query language is extended generically in `lib/http/query` (prefix fields, per-field apply hooks, expression sorts) (P3-Q6) | §4.1 |
| CA-5 | `attr.*`: same-variant semantics, needs `categoryId`, resolution over lineage + subtree (P3-Q5) | UC-CA-6, §4.1 |
| CA-6 | Relevance is rounded to 6 decimals and carried in the cursor as a string (P3-Q6) | UC-CA-6 |
| CA-7 | Public "newest" sorts on `published_at` (`publishedAt`), not `created_at`; the seller list keeps `createdAt` (P3-Q7, database D-5) | §4.1 |
| CA-8 | Caches: `v1:catalog:category-tree` (full admin tree with attributes and options; public views derived in memory), TTL `CATEGORY_TREE_CACHE_TTL_SECONDS` (3600). `v1:catalog:product:<id>` (static detail, no stock), TTL `PRODUCT_DETAIL_CACHE_TTL_SECONDS` (60). A slug is resolved to the id by one indexed lookup. Deleted after commit by product/variant writes and both consumers (P3-Q9) | UC-CA-1, §4.1 |
| CA-9 | `in_stock` is recomputed in the same transaction on variant create/update/delete, and through the consumer after stock adjustments (spec 07 IN-2, P3-Q10) | UC-CA-4, UC-CA-7 |
| CA-10 | Slug fallbacks: product `product-<6 base36>`, category create → `CATEGORY_SLUG_REQUIRED` (P3-Q12 a) | UC-CA-1, UC-CA-3 |
| CA-11 | `23001` (restrict violation) maps to `409` by default; the two `variant_attribute_values` FKs map to `OPTION_IN_USE` / `ATTRIBUTE_IN_USE` (P3-Q11, resolves CLAUDE.md P2-O1) | §6 |
| CA-12 | The seller `name like` filter runs without a trigram index (seller-scoped, small) (P3-Q12 c) | §4.3 |
| CA-13 | An active category always has an active parent: activating a child of an inactive category, or creating one under it → `409 CATEGORY_PARENT_INACTIVE` (user decision 2026-10-10, v1.1) | UC-CA-1, §6 |
