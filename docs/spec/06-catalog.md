# Spec 06 — catalog

Status: **DRAFT v0.1 (2026-10-08), under review.** [PROPOSED].
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
- Create: `depth = parent.depth + 1` (root = 1). Depth 4 → `CATEGORY_MAX_DEPTH_EXCEEDED`. `slug` defaults to kebab-case of `name`; a taken slug → `CATEGORY_SLUG_TAKEN` (the admin then sends one). Duplicate sibling name → `CATEGORY_NAME_TAKEN`.
- Update: `name`, `slug`, `sortOrder`, `isActive`. **Moving** a category (changing `parentId`) isn't supported in R1.
- Deactivate (`isActive = false`) only if it has no active child and no non-deleted product → else `CATEGORY_IN_USE`. Categories are never deleted.
- Every change deletes the category-tree cache key after commit.

### UC-CA-2 Admin manages attributes and options
- Add an attribute: the `code` must not exist on the category, any ancestor, or any descendant → `ATTRIBUTE_CODE_CONFLICT`. Allowed only while the category's **subtree has no non-deleted product** → `CATEGORY_HAS_PRODUCTS` (S-5). Over the effective-attribute limit → `ATTRIBUTE_LIMIT_REACHED`.
- Update an attribute: `name`, `sortOrder`. `code` is immutable (it's the public filter key).
- Delete an attribute: only when the subtree has no product (deleted ones included, since `variant_attribute_values` still points at it) → `ATTRIBUTE_IN_USE`.
- Options: add any time (a new choice doesn't invalidate existing variants). `code` unique per attribute → `OPTION_CODE_TAKEN`. Update `value`, `sortOrder`. Delete only if no variant (deleted ones included) uses it → `OPTION_IN_USE`.

### UC-CA-3 Seller manages products
Guard on **every** seller write: `sellers.getSellerByUserId` → `status = approved`, else `403 SELLER_NOT_APPROVED`. Reads are allowed in any seller status.
- Create: `status = draft`, `seller_active = true`, `min_price/max_price = null`, `in_stock = false`. The category must exist and be active → `CATEGORY_NOT_FOUND` (422). `slug` = kebab(name) + `-` + 6 random base36 chars, **immutable** (stable links even after a rename).
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

### UC-CA-6 Public browse & search (architecture §9)
- Only visible products (VIS: `status = active AND seller_active AND deleted_at IS NULL`). Hidden/deleted → `404 PRODUCT_NOT_FOUND`.
- `categoryId` filter includes descendants (ids from the cached tree).
- `q`: `search_vector @@ websearch_to_tsquery('english', q) OR name % q` (pg_trgm). Relevance = `ts_rank(search_vector, query) + similarity(name, q)`.

### UC-CA-7 Listing projections (event consumers)
- `seller.approved` / `seller.suspended` → `sellers.getStatuses([sellerId])` → `UPDATE products SET seller_active = (status = 'approved'), updated_at = now() WHERE seller_id = ? AND seller_active <> ?`. Invalidate product-detail cache keys of that seller.
- `inventory.stock_status_changed` → find the product of the variant → `inventory.getStockByVariantIds(active variant ids)` → `in_stock = any sellable > 0`.

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
| createdAt | `created_at` | – | – | yes |
| relevance | computed | – | – | yes (only with `q`) |
| inStock | `in_stock` | boolean | `eq` | – |
| sellerId | `seller_id` | uuid | `eq` | – |
| `attr.<code>` | `EXISTS (variant_attribute_values … option_id = ANY(?))` | option codes of that attribute | `in` (max 20 values) | – |

- Max 5 `attr.*` filters. An unknown attribute code or option code → `400 INVALID_QUERY`.
- Default sort: `-relevance` when `q` is present, else `-createdAt`. `sort=relevance` without `q` → `400 INVALID_QUERY`.

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
| `POST /admin/categories` | `parentId opt nullable uuid` · `name str(1..100)` · `slug opt slug(1..120)` · `sortOrder int(0..10000)` | `201 AdminCategoryNodeDto` | `CATEGORY_NOT_FOUND` 422 (parent), `CATEGORY_MAX_DEPTH_EXCEEDED` 422, `CATEGORY_NAME_TAKEN` 409, `CATEGORY_SLUG_TAKEN` 409, `CATEGORY_CHILD_LIMIT_REACHED` 422 |
| `PATCH /admin/categories/:categoryId` | `name opt` · `slug opt` · `sortOrder opt` · `isActive opt bool` | `200` | `CATEGORY_NOT_FOUND` 404, `CATEGORY_NAME_TAKEN`, `CATEGORY_SLUG_TAKEN`, `CATEGORY_IN_USE` 409 |
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
| `CATEGORY_CHILD_LIMIT_REACHED` | 422 | > 100 children |
| `CATEGORY_IN_USE` | 409 | Deactivating with active children or products |
| `CATEGORY_HAS_PRODUCTS` | 409 | Adding an attribute to a subtree that has products (S-5) |
| `ATTRIBUTE_NOT_FOUND` | 404 | |
| `ATTRIBUTE_CODE_CONFLICT` | 409 | Code exists on the category, an ancestor, or a descendant |
| `ATTRIBUTE_LIMIT_REACHED` | 422 | > 5 effective attributes |
| `ATTRIBUTE_IN_USE` | 409 | Delete with products in the subtree |
| `OPTION_NOT_FOUND` | 404 | |
| `OPTION_CODE_TAKEN` | 409 | `uq_category_attribute_options_attribute_id_code` |
| `OPTION_LIMIT_REACHED` | 422 | > 100 options |
| `OPTION_IN_USE` | 409 | Delete an option used by a variant |
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

## 7. Open questions
- **S-5** Adding attributes to a category that already has products.
- **S-6** Stock as deltas (route change).
- **S-17** Only approved sellers can create/edit products (no drafts while pending).
