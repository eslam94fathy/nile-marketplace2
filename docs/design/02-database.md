# System Design 02 — Database Schema (Release 1)

Status: **v1.13 APPROVED (2026-10-13).** v1.1: COD payment status `cancelled` (D-1, S-12). v1.2: refresh_tokens cleanup index + `replaced_by_id ON DELETE SET NULL` (D-4). v1.3: `notification_log` FK and failure check (Phase 1). v1.4: `idx_users_role_created_at` (DB-Q6). v1.5: public product listings sort on `published_at` (D-5); `id` tie-break on the stock-history index (D-6). v1.6: `idx_products_category_id` for category usage checks (D-7). v1.7: cart FK `ON DELETE` behaviour and why `cart_items.variant_id` has no index (§7, P4-Q11). v1.8: ordering/payments indexes, Kashier session columns, refund reason `amount_mismatch`, FK behaviour and unindexed FKs (§6, §8, §9, D-8, Phase 5). v1.9: `inventory_reservations.quantity` is what is still reserved, `>= 0`, and 0 exactly when `released` (§6, D-9). v1.10: shipment snapshots, the cancelled-after-pickup marker and the delivery list indexes (§10, D-2, D-3, D-10, Phase 6). v1.11: every timestamp a list cursor sorts on is `TIMESTAMPTZ(3)` (§0, D-11). v1.12: finance enum CHECKs, the non-negative balance guard, list indexes, FK behaviour and the duplicate-payout guard (§0, §11, D-12, Phase 7). v1.13: `idx_products_min_price_id` for the price-sorted listing without a category (§5, D-13, Phase 8 load baseline). Changes from now on need explicit approval and a version bump. Decisions: §13.
**v2.4 APPROVED (2026-10-21):** §14.6 D-17 `push_subscriptions` index and CHECK (R2-P2). **v2.3 APPROVED (2026-10-20):** §14.6 D-16 the unread partial index carries `id` (R2-P2). **v2.2 APPROVED (2026-10-20):** §14.4 D-15 category image constraints (R2-P1). **v2.1 APPROVED (2026-10-20):** §14.3 D-14 lifecycle CHECKs on `media_objects` (R2-P1). **v2.0 APPROVED (2026-10-20):** §14 adds the Release 2 schema (new tables of media, support, reviews, returns, promotions, audit; columns and indexes on existing tables; migration rules). Kept as its own section, so every cross-reference stays valid (R2-Q1). §14.15 DB-Q7…DB-Q12 answered 2026-10-20 (every recommendation accepted).
Engine: PostgreSQL 18, single `public` schema. Engineering rules: `CLAUDE.md` §6. Business rules: `docs/spec/00-overview.md` v1.0.

---

## 0. Conventions used in this document

- **std columns** = `id UUID PRIMARY KEY DEFAULT uuidv7()`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Repositories set `updated_at = now()` on every update.
- **append-only columns** = `id UUID PRIMARY KEY DEFAULT uuidv7()`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. No `updated_at`; rows are never updated.
- Every column is **NOT NULL** unless marked `null`. **No other DEFAULTs.**
- **Cursor timestamps** are `TIMESTAMPTZ(3)`: every timestamp a list cursor sorts on (`created_at` of `users`, `sellers`, `products`, `inventory_movements`, `orders`, `seller_orders`, `payment_refunds`, `delivery_agents`, `shipments`, `ledger_entries`, `cod_remittances`, `payouts`, plus `finance_accounts.updated_at` and `products.published_at`). The cursor carries a JS `Date` (milliseconds); with microseconds an ascending page repeats its last row and a descending one skips same-millisecond rows. A new list sorted on a timestamp makes that column `TIMESTAMPTZ(3)` too [v1.11, D-11].
- `money` = `NUMERIC(12,2)` with `CHECK (>= 0)`. `rate` = `NUMERIC(5,4)` with `CHECK (BETWEEN 0 AND 1)` (e.g. `0.1000` = 10%).
- `phone` = `VARCHAR(16)`, E.164 (`+201xxxxxxxxx`), validated in the DTO.
- `status`/enum columns = `VARCHAR(n)` + a named `CHECK (col IN (...))` matching the TS enum.
- Constraint names: `pk_`, `fk_<table>_<col>`, `uq_<table>_<cols>`, `idx_<table>_<cols>`, `chk_<table>_<rule>`.
- FKs are `ON DELETE RESTRICT` unless stated otherwise.
- Every index lists the **read pattern** it serves. FK columns that are never used as a lookup path get no index; this is stated where it applies.
- Extensions: `pg_trgm` (fuzzy name search). `uuidv7()` is native in Postgres 18.

## 1. Module → table ownership

| Module | Tables |
|---|---|
| identity | `users`, `refresh_tokens`, `verification_codes` |
| customers | `customers`, `customer_addresses` |
| sellers | `sellers`, `seller_status_history`, `seller_commission_history`, `seller_settings` |
| catalog | `categories`, `category_attributes`, `category_attribute_options`, `products`, `product_variants`, `variant_attribute_values` |
| inventory | `inventory_items`, `inventory_reservations`, `inventory_movements` |
| cart | `carts`, `cart_items` |
| ordering | `orders`, `seller_orders`, `order_items`, `order_item_cancellations`, `order_status_history`, `seller_order_status_history` |
| payments | `payments`, `payment_refunds`, `payment_events` |
| delivery | `governorates`, `delivery_settings`, `delivery_agents`, `shipments`, `shipment_attempts`, `shipment_status_history` |
| finance | `finance_accounts`, `ledger_entries`, `cod_remittances`, `payouts` |
| notifications | `notification_log` |
| shared (lib) | `events_outbox`, `processed_events` |

---

## 2. identity

### users
| column | type | rules |
|---|---|---|
| std columns | | |
| email | VARCHAR(254) | stored lower-cased: `chk_users_email_lowercase CHECK (email = lower(email))` |
| password_hash | VARCHAR(60) null | bcrypt output. `null` only while `status = 'invited'`: `chk_users_password_hash_required CHECK (status = 'invited' OR password_hash IS NOT NULL)` |
| role | VARCHAR(20) | `customer, seller, admin, delivery_agent` |
| status | VARCHAR(30) | `pending_email_verification, invited, active, suspended` |
| email_verified_at | TIMESTAMPTZ null | |
| last_login_at | TIMESTAMPTZ null | |

Indexes:
- `uq_users_email (email)`: login, registration duplicate check, forgot password.
- `idx_users_role_created_at (role, created_at DESC, id DESC)`: admin lists by role with keyset pagination (`WHERE role = ? … ORDER BY created_at DESC, id DESC`, spec 03 §4.11). Built `CONCURRENTLY` (DB-Q6, v1.4).

### refresh_tokens
| column | type | rules |
|---|---|---|
| append-only columns | | (+ `revoked_at`, set once) |
| user_id | UUID | `fk_refresh_tokens_user_id` → users, `ON DELETE CASCADE` |
| family_id | UUID | all rotations of one login share a family |
| token_hash | CHAR(64) | SHA-256 hex of the opaque token |
| expires_at | TIMESTAMPTZ | |
| revoked_at | TIMESTAMPTZ null | |
| replaced_by_id | UUID null | `fk_refresh_tokens_replaced_by_id` → refresh_tokens, `ON DELETE SET NULL` (audit pointer; the retention cleanup may delete rows of a family in any order, D-4) |
| user_agent | VARCHAR(255) null | for "active sessions" auditing |

Indexes:
- `uq_refresh_tokens_token_hash (token_hash)`: the refresh lookup.
- `idx_refresh_tokens_family_id (family_id)`: revoke the whole family on reuse.
- `idx_refresh_tokens_user_id (user_id) WHERE revoked_at IS NULL`: revoke all sessions on suspend or password reset.
- `idx_refresh_tokens_expires_at (expires_at)`: retention cleanup `DELETE … WHERE expires_at < now() - retention`; every refresh inserts a row, so the table is large (D-4).

### verification_codes
OTPs (email verification, password reset) and invite tokens.
| column | type | rules |
|---|---|---|
| append-only columns | | (+ `consumed_at`, `attempts` updated) |
| user_id | UUID | fk → users, `ON DELETE CASCADE` |
| purpose | VARCHAR(30) | `email_verification, password_reset, account_invite` |
| code_hash | CHAR(64) | SHA-256 of the OTP / invite token |
| expires_at | TIMESTAMPTZ | |
| attempts | SMALLINT | app inserts `0`; `CHECK (attempts >= 0)` |
| consumed_at | TIMESTAMPTZ null | |

Indexes:
- `idx_verification_codes_user_id_purpose_created_at (user_id, purpose, created_at DESC) WHERE consumed_at IS NULL`: fetch the latest active code for a user + purpose.
- `uq_verification_codes_code_hash (code_hash) WHERE purpose = 'account_invite'`: invite-link lookup by token.

---

## 3. customers

### customers
| column | type | rules |
|---|---|---|
| std columns | | |
| user_id | UUID | fk → users. `uq_customers_user_id` |
| first_name | VARCHAR(100) | |
| last_name | VARCHAR(100) | |
| phone | VARCHAR(16) | |

Indexes: `uq_customers_user_id`: resolve the profile from the JWT `sub`.

### customer_addresses (soft delete)
| column | type | rules |
|---|---|---|
| std columns | | |
| customer_id | UUID | fk → customers |
| governorate_id | UUID | fk → governorates (cross-module FK, allowed by D12) |
| label | VARCHAR(50) | e.g. "Home" |
| recipient_name | VARCHAR(100) | |
| recipient_phone | VARCHAR(16) | |
| city | VARCHAR(100) | |
| area | VARCHAR(100) | |
| street | VARCHAR(200) | |
| building | VARCHAR(50) | |
| floor | VARCHAR(10) null | |
| apartment | VARCHAR(10) null | |
| landmark | VARCHAR(200) null | |
| is_default | BOOLEAN | |
| deleted_at | TIMESTAMPTZ null | |

Indexes:
- `idx_customer_addresses_customer_id (customer_id) WHERE deleted_at IS NULL`: list my addresses.
- `uq_customer_addresses_customer_id_default (customer_id) WHERE is_default AND deleted_at IS NULL`: at most one default address.

---

## 4. sellers

### sellers
| column | type | rules |
|---|---|---|
| std columns | | |
| user_id | UUID | fk → users. `uq_sellers_user_id` |
| business_name | VARCHAR(150) | unique case-insensitive [SD-6] |
| contact_phone | VARCHAR(16) | |
| pickup_governorate_id | UUID | fk → governorates |
| pickup_city | VARCHAR(100) | |
| pickup_area | VARCHAR(100) | |
| pickup_street | VARCHAR(200) | |
| pickup_building | VARCHAR(50) | |
| pickup_landmark | VARCHAR(200) null | |
| status | VARCHAR(20) | `pending_approval, approved, rejected, suspended` |
| commission_rate | rate | the app sets it from `seller_settings.default_commission_rate` at creation |
| rejection_reason | VARCHAR(500) null | `chk_sellers_rejection_reason CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)` |
| approved_at | TIMESTAMPTZ null | |

Indexes:
- `uq_sellers_user_id (user_id)`: resolve the seller from the JWT.
- `uq_sellers_business_name_lower (lower(business_name))`: uniqueness [SD-6].
- `idx_sellers_status_created_at_id (status, created_at DESC, id DESC)`: admin list filtered by status (approval queue), cursor-paginated.

### seller_status_history (append-only)
`seller_id` fk · `from_status VARCHAR(20) null` · `to_status VARCHAR(20)` · `reason VARCHAR(500) null` · `actor_user_id UUID null` fk → users (null = system).
Index: `idx_seller_status_history_seller_id_created_at (seller_id, created_at DESC)`: admin audit view.

### seller_commission_history (append-only)
`seller_id` fk · `old_rate rate` · `new_rate rate` · `changed_by_user_id` fk → users.
Index: `idx_seller_commission_history_seller_id_created_at (seller_id, created_at DESC)`.

### seller_settings (single row)
std columns · `is_singleton BOOLEAN` with `uq_seller_settings_is_singleton` + `CHECK (is_singleton)` · `default_commission_rate rate` (seeded `0.1000` by migration).

---

## 5. catalog

### categories
| column | type | rules |
|---|---|---|
| std columns | | |
| parent_id | UUID null | fk → categories (self) |
| name | VARCHAR(100) | English [SD-1] |
| slug | VARCHAR(120) | |
| depth | SMALLINT | `CHECK (depth BETWEEN 1 AND 3)`; set by the app = parent depth + 1 |
| sort_order | INTEGER | |
| is_active | BOOLEAN | categories are deactivated, never deleted (products reference them) |

Indexes:
- `uq_categories_slug (slug)`: lookup by slug.
- `uq_categories_parent_id_name_lower (parent_id, lower(name)) NULLS NOT DISTINCT`: no duplicate sibling names (including at root level).
- No other index: the whole tree (hundreds of rows) is read at once and cached.

### category_attributes
std columns · `category_id` fk → categories · `name VARCHAR(60)` · `code VARCHAR(60)` (filter key, e.g. `size`) · `sort_order INTEGER`.
- `uq_category_attributes_category_id_code (category_id, code)`.
- The app also rejects a code that already exists on an ancestor or descendant category, because attributes are inherited (Q-30).
- Read pattern: loaded with the cached tree.

### category_attribute_options
std columns · `attribute_id` fk → category_attributes · `value VARCHAR(60)` (display, e.g. "XL") · `code VARCHAR(60)` · `sort_order INTEGER`.
`uq_category_attribute_options_attribute_id_code (attribute_id, code)`: also serves "options of an attribute".

### products (soft delete)
| column | type | rules |
|---|---|---|
| std columns | | |
| seller_id | UUID | fk → sellers |
| category_id | UUID | fk → categories (any level, Q-30) |
| name | VARCHAR(200) | |
| slug | VARCHAR(220) | |
| description | TEXT | `CHECK (char_length(description) <= 5000)` |
| status | VARCHAR(20) | `draft, active, inactive` |
| seller_active | BOOLEAN | projection of seller status (= approved), maintained by the event consumer |
| min_price | NUMERIC(12,2) null | lowest active variant price. `null` = no active variant |
| max_price | NUMERIC(12,2) null | |
| in_stock | BOOLEAN | projection: any active variant with sellable stock > 0 |
| search_vector | TSVECTOR | `GENERATED ALWAYS AS (setweight(to_tsvector('english', name), 'A') \|\| setweight(to_tsvector('english', description), 'B')) STORED` |
| published_at | TIMESTAMPTZ null | |
| deleted_at | TIMESTAMPTZ null | |

The public "visible" predicate, used by every public partial index (abbreviated **VIS**): `status = 'active' AND seller_active AND deleted_at IS NULL`.

Indexes:
- `uq_products_slug (slug)`: product detail by slug.
- `idx_products_category_id_published_at_id (category_id, published_at DESC, id DESC) WHERE VIS`: category listing, newest first (D-5, v1.5).
- `idx_products_category_id_min_price_id (category_id, min_price, id) WHERE VIS`: category listing sorted or filtered by price.
- `idx_products_published_at_id (published_at DESC, id DESC) WHERE VIS`: listing without a category filter (D-5, v1.5).
- `idx_products_min_price_id (min_price, id) WHERE VIS`: listing sorted (or filtered) by price without a category filter; built concurrently [v1.13, D-13].
- `idx_products_search_vector USING GIN (search_vector) WHERE VIS`: full-text search.
- `idx_products_name_trgm USING GIN (name gin_trgm_ops) WHERE VIS`: typo-tolerant / partial-word search.
- `idx_products_category_id (category_id)`: category usage checks outside VIS (deactivate a category, add or delete an attribute in a subtree, `PRODUCT_CATEGORY_LOCKED`), deleted products included; also the FK (D-7, v1.6).
- `idx_products_seller_id_created_at_id (seller_id, created_at DESC, id DESC) WHERE deleted_at IS NULL`: seller dashboard list. It also serves the projection update `WHERE seller_id = ?`.

### product_variants (soft delete)
| column | type | rules |
|---|---|---|
| std columns | | |
| product_id | UUID | fk → products |
| seller_id | UUID | fk → sellers (denormalized from the product, for per-seller SKU uniqueness) |
| sku | VARCHAR(64) | |
| price | money | `CHECK (price > 0)` |
| compare_at_price | NUMERIC(12,2) null | `CHECK (compare_at_price IS NULL OR compare_at_price > price)` |
| status | VARCHAR(20) | `active, inactive` |
| option_signature | CHAR(64) | SHA-256 of the sorted option ids, so the same combination can't exist twice |
| is_default | BOOLEAN | the single variant of a product in a category without attributes [SD-7] |
| deleted_at | TIMESTAMPTZ null | |

Indexes:
- `idx_product_variants_product_id (product_id) WHERE deleted_at IS NULL`: product detail, and recomputing min/max price.
- `uq_product_variants_seller_id_sku_lower (seller_id, lower(sku)) WHERE deleted_at IS NULL`: SKU unique per seller.
- `uq_product_variants_product_id_option_signature (product_id, option_signature) WHERE deleted_at IS NULL`.

### variant_attribute_values (composite PK [SD-8])
`variant_id` fk → product_variants `ON DELETE CASCADE` · `attribute_id` fk → category_attributes · `option_id` fk → category_attribute_options.
- `pk_variant_attribute_values (variant_id, attribute_id)`: one value per attribute per variant. Also serves "attributes of these variants" (batched).
- `idx_variant_attribute_values_option_id_variant_id (option_id, variant_id)`: listing filter `attr[size]=xl` → `EXISTS (… WHERE option_id = ANY(?) AND variant_id = v.id)`.

---

## 6. inventory

### inventory_items
| column | type | rules |
|---|---|---|
| std columns | | |
| variant_id | UUID | fk → product_variants. `uq_inventory_items_variant_id` |
| on_hand | INTEGER | `CHECK (on_hand >= 0)` |
| reserved | INTEGER | `CHECK (reserved >= 0)`, `chk_inventory_items_reserved_lte_on_hand CHECK (reserved <= on_hand)` |

- Sellable = `on_hand - reserved`.
- Reserve: `UPDATE … SET reserved = reserved + :q WHERE id = :id AND on_hand - reserved >= :q RETURNING …`. 0 rows → insufficient stock.
- Commit (delivered): `on_hand -= q, reserved -= q`. Release: `reserved -= q`.

Index: `uq_inventory_items_variant_id`: batched lookup `variant_id = ANY(?)` (cart, checkout, product detail).

### inventory_reservations
std columns · `inventory_item_id` fk · `order_item_id` fk → order_items · `quantity INTEGER CHECK (quantity >= 0)`: what is still reserved; a release lowers it, a commit keeps it [v1.9] · `status VARCHAR(20)` (`active, committed, released`) · `chk_inventory_reservations_released CHECK ((status = 'released') = (quantity = 0))` [v1.9, D-9].
- `uq_inventory_reservations_order_item_id (order_item_id)`: one reservation per order line. Also the commit/release lookup.
- FKs `ON DELETE RESTRICT`. No index on `inventory_item_id`: nothing looks reservations up by item, and items are never deleted [v1.8, D-8].
- Partial item cancellation lowers `quantity` and releases the difference, with a movement row.

### inventory_movements (append-only, audit)
`inventory_item_id` fk · `type VARCHAR(30)` (`seller_adjustment, reserve, release, commit`) · `quantity_delta INTEGER` · `on_hand_after INTEGER` · `reserved_after INTEGER` · `reference_type VARCHAR(30) null` · `reference_id UUID null` · `actor_user_id UUID null`.
Index: `idx_inventory_movements_inventory_item_id_created_at_id (inventory_item_id, created_at DESC, id DESC)`: seller stock history with keyset pagination (D-6, v1.5).

---

## 7. cart

### carts
std columns · `customer_id` fk → customers (`fk_carts_customer_id`, `ON DELETE RESTRICT`). `uq_carts_customer_id`: one cart per customer, the lookup path, and the conflict target of the add's create-and-lock upsert.

### cart_items
std columns · `cart_id` fk `ON DELETE CASCADE` (`fk_cart_items_cart_id`) · `variant_id` fk → product_variants (`fk_cart_items_variant_id`, `ON DELETE RESTRICT`) · `quantity INTEGER CHECK (quantity BETWEEN 1 AND 99)` [DB-Q3]. Max **50** distinct lines per cart, enforced by the app (config).
`uq_cart_items_cart_id_variant_id (cart_id, variant_id)`: one line per variant, and serves "items of my cart".
No index on `variant_id`: nothing looks lines up by variant, and variants are never hard-deleted (soft delete), so the `RESTRICT` check never runs (P4-Q11).

---

## 8. ordering

### orders
| column | type | rules |
|---|---|---|
| std columns | | |
| order_number | VARCHAR(20) | `'NM-' \|\| lpad(nextval('order_number_seq')::text, 9, '0')`, set explicitly in the INSERT [SD-10]. The sequence is created in the `orders` migration [v1.8] |
| customer_id | UUID | fk → customers |
| status | VARCHAR(30) | `pending_payment, placed, in_progress, completed, partially_completed, cancelled` |
| payment_method | VARCHAR(20) | `cod, kashier` |
| items_total | money | Σ seller order subtotals (recomputed on cancellations) |
| delivery_fee | money | snapshot. Becomes `0` if all seller orders end undelivered (Q-28) |
| agent_fee_share_rate | rate | snapshot of the 70% setting |
| total | money | `chk_orders_total CHECK (total = items_total + delivery_fee)` |
| ship_governorate_id | UUID | fk → governorates |
| ship_governorate_name | VARCHAR(100) | |
| ship_recipient_name | VARCHAR(100) | |
| ship_recipient_phone | VARCHAR(16) | |
| ship_city, ship_area | VARCHAR(100) | |
| ship_street | VARCHAR(200) | |
| ship_building | VARCHAR(50) | |
| ship_floor, ship_apartment | VARCHAR(10) null | |
| ship_landmark | VARCHAR(200) null | |
| payment_expires_at | TIMESTAMPTZ null | Kashier only: checkout + 15 min |
| placed_at, completed_at, cancelled_at | TIMESTAMPTZ null | |

Indexes:
- `uq_orders_order_number (order_number)`: support/agent lookup.
- `idx_orders_customer_id_created_at_id (customer_id, created_at DESC, id DESC)`: "my orders".
- `idx_orders_payment_expires_at (payment_expires_at) WHERE status = 'pending_payment'`: the expiry job.
- `idx_orders_status_created_at_id (status, created_at DESC, id DESC)`: admin order list by status.
- `idx_orders_created_at_id (created_at DESC, id DESC)`: admin order list without a status filter (default sort `-createdAt`) [v1.8, D-8].

### seller_orders
| column | type | rules |
|---|---|---|
| std columns | | |
| order_id | UUID | fk → orders |
| seller_id | UUID | fk → sellers |
| status | VARCHAR(30) | `pending_payment, placed, accepted, ready_for_pickup, picked_up, out_for_delivery, delivery_failed, returning_to_seller, returned_to_seller, delivered, cancelled` |
| subtotal | money | |
| commission_rate | rate | snapshot |
| commission | money | |
| seller_net | money | `chk_seller_orders_net CHECK (seller_net = subtotal - commission)` |
| pickup_governorate_id | UUID | fk → governorates |
| pickup_phone | VARCHAR(16) | |
| pickup_city, pickup_area | VARCHAR(100) | |
| pickup_street | VARCHAR(200) | |
| pickup_building | VARCHAR(50) | |
| pickup_landmark | VARCHAR(200) null | |
| accept_deadline_at | TIMESTAMPTZ null | set when `placed` (+24 h) |
| cancel_reason | VARCHAR(40) null | `customer_cancelled, seller_cancelled, seller_acceptance_timeout, payment_failed, payment_expired` |
| cancelled_by_user_id | UUID null | fk → users (null = system) |
| accepted_at, ready_at, picked_up_at, delivered_at, returned_at, cancelled_at | TIMESTAMPTZ null | |

Indexes:
- `uq_seller_orders_order_id_seller_id (order_id, seller_id)`: one per seller per order. Also serves "seller orders of an order".
- `idx_seller_orders_seller_id_status_created_at_id (seller_id, status, created_at DESC, id DESC)`: seller dashboard (filter by status, newest first).
- `idx_seller_orders_seller_id_created_at_id (seller_id, created_at DESC, id DESC)`: seller dashboard without a status filter.
- `idx_seller_orders_accept_deadline_at (accept_deadline_at) WHERE status = 'placed'`: the 24 h timeout job.

### order_items
| column | type | rules |
|---|---|---|
| std columns | | |
| seller_order_id | UUID | fk → seller_orders |
| variant_id | UUID | fk → product_variants |
| product_id | UUID | fk → products |
| product_name | VARCHAR(200) | snapshot |
| sku | VARCHAR(64) | snapshot |
| variant_attributes | JSONB | snapshot `[{ "attribute": "Size", "value": "XL" }]`, `CHECK (jsonb_typeof(variant_attributes) = 'array')` |
| unit_price | money | snapshot |
| quantity | INTEGER | `CHECK (quantity > 0)` |
| cancelled_quantity | INTEGER | app inserts 0. `CHECK (cancelled_quantity BETWEEN 0 AND quantity)` |
| line_total | money | `= unit_price × (quantity − cancelled_quantity)` |

Index: `idx_order_items_seller_order_id (seller_order_id)`: items of seller orders (batched `= ANY(?)`).
No indexes on `variant_id` / `product_id`: nothing looks order lines up by variant or product, and variants and products are only soft-deleted, so the `RESTRICT` check never runs [v1.8, D-8].

### order_item_cancellations (append-only)
`order_item_id` fk · `quantity INTEGER CHECK (> 0)` · `reason VARCHAR(40)` (`out_of_stock, seller_request, other`) · `note VARCHAR(500) null` · `actor_user_id` fk → users.
Index: `idx_order_item_cancellations_order_item_id (order_item_id)`.

### order_status_history / seller_order_status_history (append-only)
`order_id` (or `seller_order_id`) fk · `from_status VARCHAR(30) null` · `to_status VARCHAR(30)` · `actor_role VARCHAR(20)` (`customer, seller, admin, delivery_agent, system`) · `actor_user_id UUID null` · `reason VARCHAR(500) null`.
Index: `(order_id | seller_order_id, created_at)`: timeline view.

Every FK in §8 is `ON DELETE RESTRICT` [v1.8, D-8].

---

## 9. payments

### payments
| column | type | rules |
|---|---|---|
| std columns | | |
| order_id | UUID | fk → orders. `uq_payments_order_id` (one per checkout, Q-9) |
| method | VARCHAR(20) | `cod, kashier` |
| status | VARCHAR(40) | COD: `pending, partially_collected, collected, cancelled` (`cancelled` = nothing collected because every seller order ended undelivered, D-1). Kashier: `initiated, paid, failed, expired, partially_refunded_manually, refunded_manually` |
| amount | money | order total at checkout (adjusted on cancellations before payment) |
| collected_amount | money | COD: sum collected by agents. Kashier: amount paid. The app inserts 0 |
| refunded_amount | money | app inserts 0. `CHECK (refunded_amount <= collected_amount)` |
| provider_order_ref | VARCHAR(100) null | the Kashier session id |
| provider_session_url | VARCHAR(500) null | Kashier `sessionUrl`; null for COD and before a session exists [v1.8, D-8] |
| provider_session_expires_at | TIMESTAMPTZ null | the session's `expireAt`; set together with the two columns above (`chk_payments_session_columns`: all three null or all three set) [v1.8, D-8] |
| provider_transaction_ref | VARCHAR(100) null | the Kashier transaction id |
| paid_at | TIMESTAMPTZ null | |

Indexes:
- `uq_payments_order_id (order_id)`.
- `uq_payments_provider_order_ref (provider_order_ref) WHERE provider_order_ref IS NOT NULL`: webhook → payment lookup.

### payment_refunds
std columns · `payment_id` fk · `seller_order_id UUID null` fk (null = whole order / fee) · `amount money CHECK (> 0)` · `reason VARCHAR(40)` (`seller_order_cancelled, items_cancelled, delivery_failed, late_payment_after_expiry, all_cancelled_fee, amount_mismatch`; `amount_mismatch` v1.8, spec 10 PA-6) · `status VARCHAR(20)` (`pending_manual, recorded`) · `recorded_by_user_id UUID null` · `recorded_at TIMESTAMPTZ null` · `provider_refund_ref VARCHAR(100) null`.
Indexes:
- `idx_payment_refunds_created_at_id (created_at, id) WHERE status = 'pending_manual'`: the admin refund queue, oldest first, with the keyset `id` tie-break [v1.8, D-8].
- `idx_payment_refunds_payment_id (payment_id)`.
- No index on `seller_order_id`: nothing looks refunds up by seller order [v1.8, D-8].

### payment_events (append-only, webhook inbox)
`payment_id UUID null` fk · `provider VARCHAR(20)` (`kashier`) · `provider_event_id VARCHAR(100)` · `event_type VARCHAR(50)` · `payload JSONB` (secrets/card data stripped) · `signature_valid BOOLEAN` · `processed_at TIMESTAMPTZ null`.
`uq_payment_events_provider_provider_event_id (provider, provider_event_id)`: webhook dedupe.
`idx_payment_events_payment_id (payment_id)`: the admin payment view lists a payment's events [v1.8, D-8].
Every FK in §9 is `ON DELETE RESTRICT` [v1.8, D-8].

---

## 10. delivery

### governorates
std columns · `code VARCHAR(10)` (ISO 3166-2:EG, e.g. `EG-C`) · `name VARCHAR(100)` · `delivery_fee NUMERIC(12,2) null` (`CHECK (delivery_fee IS NULL OR delivery_fee >= 0)`, `null` = not deliverable, Q-26).
- `uq_governorates_code`.
- The 27 governorates are seeded by migration, and the whole table is read at once and cached.

### delivery_settings (single row)
std columns · `is_singleton` (as in `seller_settings`) · `agent_fee_share_rate rate` (seeded `0.7000`).

### delivery_agents
std columns · `user_id` fk → users (`uq_delivery_agents_user_id`) · `full_name VARCHAR(100)` · `phone VARCHAR(16)` · `home_governorate_id` fk → governorates · `status VARCHAR(20)` (`active, inactive`) · `on_shift BOOLEAN` · `last_assigned_at TIMESTAMPTZ null`.
Indexes:
- `uq_delivery_agents_user_id`: resolve the agent from the JWT.
- `idx_delivery_agents_home_governorate_id_last_assigned_at (home_governorate_id, last_assigned_at NULLS FIRST) WHERE status = 'active' AND on_shift`: candidate selection for auto-assignment.
- `idx_delivery_agents_created_at_id (created_at DESC, id DESC)`: `GET /admin/delivery-agents` [v1.10, D-10].

### shipments
| column | type | rules |
|---|---|---|
| std columns | | |
| seller_order_id | UUID | fk → seller_orders. `uq_shipments_seller_order_id` (idempotent creation) |
| order_id | UUID | fk → orders (shipments of one checkout: fee split and fee carrier) |
| agent_id | UUID null | fk → delivery_agents |
| status | VARCHAR(30) | `unassigned, assigned, picked_up, out_for_delivery, delivery_failed, returning_to_seller, returned_to_seller, delivered, cancelled` |
| order_number | VARCHAR(20) | snapshot for the agent's screen [v1.10, D-2] |
| payment_method | VARCHAR(20) | `cod, kashier` (CHECK) [v1.10, D-2] |
| order_delivery_fee | money | the checkout's COD fee, used by the fee carrier; `0.00` for Kashier [v1.10, D-2] |
| pickup_business_name | VARCHAR(150) | snapshot [v1.10, D-2] |
| pickup_* / dropoff_* | | address snapshots copied from the event payload (same columns as on orders / seller_orders, plus `dropoff_governorate_name`) |
| cod_items_amount | money | COD: seller order subtotal to collect. Kashier: 0 |
| carries_delivery_fee | BOOLEAN | `true` on the one shipment that collects the COD fee: the first of the checkout to go `out_for_delivery`. Moves to the next shipment going out if this one fails or returns [SD-2, DB-Q1 approved] |
| cod_fee_amount | money | the fee if `carries_delivery_fee`, else 0 |
| cod_collected_amount | NUMERIC(12,2) null | set on delivered |
| attempt_count | SMALLINT | app inserts 0. `CHECK (attempt_count BETWEEN 0 AND 3)` |
| assigned_at, picked_up_at, delivered_at, returned_at | TIMESTAMPTZ null | |
| seller_order_cancelled_at | TIMESTAMPTZ null | set when the seller order is cancelled after pickup: the agent then confirms the return himself (spec 11 DE-6) [v1.10, D-10] |

No `agent_fee_share` column: ordering computes the share and the ledger records it [v1.10, D-2]. Every FK is `ON DELETE RESTRICT` [v1.10, D-10].

Indexes:
- `uq_shipments_seller_order_id`.
- `idx_shipments_agent_id_status (agent_id, status) WHERE agent_id IS NOT NULL`: the agent's active list, and the "active shipment count" used for assignment.
- `idx_shipments_created_at_id (created_at, id) WHERE status = 'unassigned'`: the assignment retry job, oldest first with a keyset tie-break [v1.10, D-10].
- `idx_shipments_status_created_at_id (status, created_at DESC, id DESC)`: `GET /admin/shipments?status[…]` [v1.10, D-3].
- `idx_shipments_created_at_desc_id (created_at DESC, id DESC)`: the unfiltered admin list [v1.10, D-10].
- `idx_shipments_agent_id_created_at_id (agent_id, created_at, id) WHERE agent_id IS NOT NULL`: the agent's list, oldest first, also over a long delivered history [v1.10, D-10].
- `idx_shipments_order_id (order_id)`: shipments of one checkout.
- `uq_shipments_order_id_fee_carrier (order_id) WHERE carries_delivery_fee`: **at most one** fee-carrying shipment per checkout.

### shipment_attempts (append-only)
`shipment_id` fk · `attempt_number SMALLINT CHECK (BETWEEN 1 AND 3)` · `reason VARCHAR(30)` (`customer_unreachable, customer_refused, wrong_address, customer_rescheduled`) · `note VARCHAR(500) null` · `agent_id` fk.
`uq_shipment_attempts_shipment_id_attempt_number`: no duplicate attempt numbers, and serves "attempts of a shipment". No index on `agent_id` (audit pointer) [v1.10, D-10].

### shipment_status_history (append-only)
Same shape as the order histories. Index `(shipment_id, created_at)`.

---

## 11. finance

Balances are stored per account, and every change is an immutable ledger entry written **in the same transaction** as the balance update (row-locked). This gives fast balance reads plus a full audit trail. Every FK is `ON DELETE RESTRICT` [v1.12, D-12].

### finance_accounts
std columns (`updated_at TIMESTAMPTZ(3)`: cursor-sorted [v1.12, D-12]) · `account_type VARCHAR(30)` (CHECK) · `owner_id UUID null` · `balance NUMERIC(14,2)` (signed).
- `owner_id` is polymorphic (a seller id or an agent id; null for the platform accounts), so it has **no FK**. Accounts are created only by a booking or an admin action that already resolved the owner [v1.12, D-12].
- `chk_finance_accounts_balance_non_negative CHECK (account_type = 'platform_delivery_revenue' OR balance >= 0)`: the DB backs the app's check. Only delivery revenue may go negative (spec 12 §1.1, FI-1) [v1.12, D-12].

Account types:
- `seller_payable` (owner = seller): what the platform owes the seller.
- `agent_fee_payable` (owner = agent): what the platform owes the agent in fee shares.
- `agent_cod_cash` (owner = agent): cash the agent holds that belongs to the platform.
- `platform_commission_revenue`, `platform_delivery_revenue` (owner = null).

Indexes:
- `uq_finance_accounts_account_type_owner_id (account_type, owner_id) NULLS NOT DISTINCT`: one account per type and owner; resolves an owner's account and backs the lazy `INSERT … ON CONFLICT DO NOTHING`.
- `idx_finance_accounts_balance_id (balance DESC, id DESC)`: `GET /admin/finance/accounts`, default sort `-balance` [v1.12, D-12].
- `idx_finance_accounts_updated_at_id (updated_at DESC, id DESC)`: the same list sorted by `updatedAt` [v1.12, D-12].
The table stays small (one row per seller, two per agent, two platform rows), so these indexes cost one small update per booking.

### ledger_entries (append-only)
append-only columns (`created_at TIMESTAMPTZ(3)` [v1.12, D-12]) · `account_id` fk → finance_accounts · `direction VARCHAR(6)` (`credit, debit`) · `amount money CHECK (> 0)` · `balance_after NUMERIC(14,2)` · `entry_type VARCHAR(40)` (`seller_net_earned, commission_earned, agent_fee_earned, platform_fee_earned, cod_cash_collected, cod_cash_remitted, seller_payout, agent_payout`) · `reference_type VARCHAR(30)` (`seller_order, order, cod_remittance, payout`) [v1.12, D-12] · `reference_id UUID` · `source_event_id UUID null` (null for admin actions, which have no event).
Every enum column has its named CHECK [v1.12, D-12]. `reference_id` points at another module's row or at a finance row, depending on `reference_type`, so it has no FK.
Indexes:
- `idx_ledger_entries_account_id_created_at_id (account_id, created_at DESC, id DESC)`: account statement, cursor-paginated (also the FK's lookup path).
- `idx_ledger_entries_reference_type_reference_id (reference_type, reference_id)`: "all money movements of seller order X".

### cod_remittances (append-only)
append-only columns (`created_at TIMESTAMPTZ(3)` [v1.12, D-12]) · `agent_id` fk → delivery_agents · `amount money CHECK (> 0)` · `confirmed_by_user_id` fk → users · `note VARCHAR(500) null`.
Indexes:
- `idx_cod_remittances_agent_id_created_at_id (agent_id, created_at DESC, id DESC)`: `GET /admin/finance/cod-remittances?agentId[eq]=…` and `GET /agent/finance/remittances`, with the keyset tie-break [v1.12, D-12].
- `idx_cod_remittances_created_at_id (created_at DESC, id DESC)`: the unfiltered admin list [v1.12, D-12].
- No index on `confirmed_by_user_id` (audit pointer, never a lookup path) [v1.12, D-12].

### payouts (append-only)
append-only columns (`created_at TIMESTAMPTZ(3)` [v1.12, D-12]) · `payee_type VARCHAR(20)` (`seller, agent`) · `payee_id UUID` (polymorphic, no FK) · `amount money CHECK (> 0)` · `external_reference VARCHAR(200)` (bank / wallet transfer ref) · `recorded_by_user_id` fk → users · `paid_at TIMESTAMPTZ`.
Indexes:
- `idx_payouts_payee_type_payee_id_created_at_id (payee_type, payee_id, created_at DESC, id DESC)`: `GET /admin/finance/payouts?payeeType[eq]=…&payeeId[eq]=…`, `GET /seller/finance/payouts`, with the keyset tie-break [v1.12, D-12].
- `idx_payouts_created_at_id (created_at DESC, id DESC)`: the unfiltered admin list [v1.12, D-12].
- `uq_payouts_payee_type_payee_id_external_reference`: the same transfer can't be recorded twice for one payee → `409 PAYOUT_ALREADY_RECORDED` (spec 12 FI-7) [v1.12, D-12].
- No index on `recorded_by_user_id` (audit pointer) [v1.12, D-12].
A payout amount must be ≤ the account balance. This is checked under `SELECT … FOR UPDATE` on the account row.

---

## 12. notifications & shared

### notification_log
std columns · `user_id UUID null` `fk_notification_log_user_id` → users `ON DELETE SET NULL` (the log outlives the user) · `template VARCHAR(50)` (`email_verification, password_reset, account_invite`) · `to_email VARCHAR(254)` · `status VARCHAR(20)` (`sent, failed`) · `provider_message_id VARCHAR(100) null` · `error VARCHAR(2000) null` · `source_event_id UUID`.
- `uq_notification_log_source_event_id`: never send the same email twice.
- `idx_notification_log_user_id_created_at`: support lookup.
- `chk_notification_log_error_on_failure CHECK (status = 'sent' OR error IS NOT NULL)`: a failed row always says why (v1.3).
- The OTP itself is never stored here.

### events_outbox
`id UUID PK DEFAULT uuidv7()` (= `eventId`) · `aggregate_type VARCHAR(50)` · `aggregate_id UUID` · `event_type VARCHAR(100)` · `event_version SMALLINT` · `payload JSONB` · `correlation_id UUID null` · `created_at TIMESTAMPTZ DEFAULT now()` · `dispatched_at TIMESTAMPTZ null` · `attempts INTEGER` (app inserts 0) · `next_attempt_at TIMESTAMPTZ` (app sets = now) · `last_error VARCHAR(2000) null`.
Indexes:
- `idx_events_outbox_next_attempt_at_id (next_attempt_at, id) WHERE dispatched_at IS NULL`: drain scan.
- `idx_events_outbox_dispatched_at (dispatched_at) WHERE dispatched_at IS NOT NULL`: the cleanup job.

### processed_events (composite PK [SD-8])
`consumer VARCHAR(100)` · `event_id UUID` · `processed_at TIMESTAMPTZ DEFAULT now()`. `pk_processed_events (consumer, event_id)`.
Index: `idx_processed_events_processed_at`: the cleanup job.

---

## 13. Decisions log (2026-10-07)

| # | Decision |
|---|---|
| DB-Q1 | COD fee carried by the first shipment of the checkout to go `out_for_delivery`, moving to the next one on failure/return. Enforced by `uq_shipments_order_id_fee_carrier` |
| DB-Q2 | Customer profile `phone` is required at registration (plus `recipient_phone` per address) |
| DB-Q3 | Cart: max quantity **99** per line, max **50** lines |
| DB-Q4 | Lengths: product `name` 200, `description` 5000, seller `business_name` 150 |
| DB-Q5 | Retention: dispatched outbox 7 days, processed events 30 days, expired codes/tokens 30 days (all env config) |
| DB-Q6 | `idx_users_role_created_at (role, created_at DESC, id DESC)` for the admin list (spec 03 §4.11), added in Phase 1 as a `CREATE INDEX CONCURRENTLY` migration (2026-10-08) |
| D-5 | Public product listings sort "newest" on `published_at`; the two public listing indexes use `(…, published_at DESC, id DESC) WHERE VIS` (P3-Q7, 2026-10-10) |
| D-6 | `idx_inventory_movements_inventory_item_id_created_at_id` includes `id` for the keyset tie-break (P3-Q8, 2026-10-10) |
| D-7 | `idx_products_category_id (category_id)`: the category usage checks run outside VIS and would otherwise scan `products` (Phase 3 implementation, 2026-10-10) |
| D-8 | Phase 5 (P5-Q4, 2026-10-12): `idx_orders_created_at_id`; `idx_payment_events_payment_id`; refund queue index with `id`; `payments.provider_session_url` + `provider_session_expires_at`; `RefundReason` `amount_mismatch`; every ordering/payments/reservation FK `ON DELETE RESTRICT`; no indexes on `order_items.variant_id` / `product_id`, `inventory_reservations.inventory_item_id`, `payment_refunds.seller_order_id`; `order_number_seq` created with `orders` |
| D-9 | `inventory_reservations.quantity >= 0` with `chk_inventory_reservations_released` (released ⇔ 0), so a full release can lower it to 0 as spec 07 UC-IN-2 says; the earlier `> 0` contradicted it (Phase 5 migrations, 2026-10-12) |
| D-10 | Phase 6 (P6-Q3, P6-Q5, 2026-10-12): D-2 (shipment snapshots, no `agent_fee_share`) and D-3 (`idx_shipments_status_created_at_id`) applied; plus `idx_shipments_created_at_desc_id`, `idx_shipments_agent_id_created_at_id`, the retry index with `id`, `idx_delivery_agents_created_at_id`, `shipments.seller_order_cancelled_at`, every delivery FK `ON DELETE RESTRICT`, no index on `shipment_attempts.agent_id` |
| D-11 | Every timestamp a list cursor sorts on is `TIMESTAMPTZ(3)` (§0): the cursor carries a JS `Date`, so microseconds repeated rows on ascending pages and skipped same-millisecond rows on descending ones. Migration `20261012140001` (Phase 6 implementation, 2026-10-12) |
| D-12 | Phase 7 (P7-Q3, P7-Q8, 2026-10-13): finance cursor timestamps `TIMESTAMPTZ(3)`; `chk_finance_accounts_balance_non_negative` (every type but `platform_delivery_revenue`); CHECKs on every finance enum column, including the new `reference_type`; `idx_finance_accounts_balance_id`, `idx_finance_accounts_updated_at_id`; `id` tie-break on the remittance and payout payee indexes; `idx_cod_remittances_created_at_id`, `idx_payouts_created_at_id`; `uq_payouts_payee_type_payee_id_external_reference`; FKs `ON DELETE RESTRICT`, polymorphic `owner_id` / `payee_id` without FK, no index on the `*_by_user_id` audit pointers |
| D-13 | `idx_products_min_price_id (min_price, id) WHERE VIS`, built concurrently: the public listing sorted by price without a category read and sorted every visible product (144 ms idle, ~300 ms under load on 100k products), found by the P8 load baseline (2026-10-13) |
| DB-Q7…DB-Q12 | Release 2 (2026-10-20, §14.15): new `NOT NULL` columns via `ADD COLUMN … DEFAULT v` + `DROP DEFAULT` in one migration · an admin block sets `status = 'inactive'` and locks the status, VIS unchanged (spec 20 §3.4 amended) · partial index on `order_items.image_media_id` · rating sort indexed globally only, per-category after measuring · encrypted payout details as `TEXT` with a length CHECK · no holds for seller orders delivered before R2 |

No open schema questions.

---

## 14. Release 2 schema [v2.0, approved 2026-10-20]

Inputs: specs 01–20 Release 2 sections, architecture v2.0 §14. The conventions of §0 apply unchanged. §1–§12 still describe Release 1; this section stays separate (R2-Q1). Decisions in §14.15 (DB-Q7…DB-Q12, answered 2026-10-20).

### 14.1 Ownership additions (§1)
| Module | Tables |
|---|---|
| media | `media_objects` |
| catalog | + `product_images` |
| customers | + `wishlist_items` |
| notifications | + `user_notifications`, `notification_preferences`, `push_subscriptions` |
| support | `support_tickets`, `support_messages`, `support_message_attachments`, `support_ticket_reads` |
| reviews | `product_reviews`, `review_images`, `review_replies`, `review_rating_stats` |
| returns | `return_requests`, `return_items`, `return_photos`, `return_status_history` |
| promotions | `coupons`, `coupon_redemptions` |
| ordering | + `order_item_returns` |
| finance | + `seller_order_holds` |
| audit | `admin_audit_log` |

### 14.2 Migration rules for R2 (CLAUDE.md §6.1)
- **New `NOT NULL` columns on existing tables** (DB-Q7): `ADD COLUMN … NOT NULL DEFAULT <value>` (metadata-only in Postgres ≥ 11, no table rewrite) immediately followed, in the same migration, by `ALTER COLUMN … DROP DEFAULT`. The schema ends with no DB default (G13, D5); existing rows hold the stated backfill value and new rows must pass it.
- **New `CHECK` / FK constraints on large existing tables** (`products`, `orders`, `seller_orders`, `order_items`, `shipments`, `payment_refunds`, `ledger_entries`): added `NOT VALID`, then `VALIDATE CONSTRAINT` in a later migration (no long exclusive lock).
- **Indexes on existing tables**: `CREATE INDEX CONCURRENTLY` in their own non-transactional migrations (`config.transaction = false`), as DB-Q6 / D-13.
- **Enum value removals** (`partially_refunded_manually`, `refunded_manually`, PA-23): expand (CHECK accepts old + new) → backfill → contract (CHECK without the old values) in a later release, after every reader runs the new code.
- New tables are created in one migration per module (one concern each).

### 14.3 media
#### media_objects
std columns (`created_at TIMESTAMPTZ(3)`) · `owner_user_id` fk → users · `purpose VARCHAR(30)` (`product_image, category_image, support_attachment, review_image, return_photo`) · `status VARCHAR(20)` (`pending, processing, ready, failed`) · `failure_reason VARCHAR(30) null` (`decode_failed, unsupported_type, dimensions_out_of_range`; `chk_media_objects_failure_reason`: set ⇔ `failed`) · `declared_content_type VARCHAR(20)` (`image/jpeg, image/png, image/webp`) · `declared_size_bytes INTEGER CHECK (> 0)` · `width SMALLINT null`, `height SMALLINT null` (set ⇔ `ready`, CHECK) · `processed_at`, `claimed_at`, `released_at`, `retained_at` `TIMESTAMPTZ null`.
Storage keys are derived from `id` and `purpose` (spec 14 §1.1), never stored.
Indexes:
- `idx_media_objects_owner_user_id_open (owner_user_id) WHERE status IN ('pending','processing')`: the open-upload count (UC-ME-1).
- `idx_media_objects_cleanup (created_at, id) WHERE claimed_at IS NULL AND status <> 'processing'`: cleanup candidates `pending` / unclaimed `ready` / `failed` (UC-ME-4).
- `idx_media_objects_released (released_at, id) WHERE released_at IS NOT NULL AND retained_at IS NULL`: released candidates.
- `idx_media_objects_processing (updated_at) WHERE status = 'processing'`: the stuck-processing check.
- No index on `owner_user_id` beyond the partial one (no other lookup by owner).
- **D-14 (v2.1):** lifecycle CHECKs besides the two above: `ready` ⇔ `width`, `height` and `processed_at` set (both dimensions `> 0`); `chk_media_objects_claimed` (claimed only when `ready`), `chk_media_objects_released` (released only after a claim), `chk_media_objects_retained` (retained only after a release). `width` / `height` stay `SMALLINT`: the processor refuses outputs over 16 383 px a side (spec 14 ME-12).

### 14.4 catalog
- `products` += `rating_count INTEGER` (backfill 0, `CHECK (>= 0)`) · `rating_avg NUMERIC(3,2) null` (`CHECK (rating_avg BETWEEN 1 AND 5)`, null ⇔ `rating_count = 0`) · `rating_version BIGINT` (backfill 0) · `admin_blocked_at TIMESTAMPTZ null`, `admin_block_reason VARCHAR(500) null` (both null or both set).
- **Admin block and VIS** (DB-Q8): a block also sets `status = 'inactive'`, and the seller can't change the status while `admin_blocked_at` is set (spec 20 §3.4, `PRODUCT_BLOCKED`). VIS (§5) stays as it is, so none of the seven VIS partial indexes is rebuilt. Unblock clears the two columns and leaves the product `inactive`; the seller re-activates it.
- New index `idx_products_rating_id ((COALESCE(rating_avg, 0)) DESC, id DESC) WHERE VIS`, concurrently: public listing sorted by `-rating` without a category (spec 06 §9.3). Within a category, the planner uses `idx_products_category_id_published_at_id` and sorts the category's rows (bounded by category size); a `(category_id, rating, id)` index is added only if the P9 / R2-P8 load test shows the need.
- `categories` += `image_media_id UUID null` (fk → media_objects, `uq_categories_image_media_id`) · `image_alt_text VARCHAR(200) null`.
#### product_images
std columns · `product_id` fk · `media_id` fk → media_objects (`uq_product_images_media_id`) · `variant_id UUID null` fk → product_variants · `position SMALLINT CHECK (BETWEEN 0 AND 7)` · `alt_text VARCHAR(200) null`.
- `uq_product_images_product_id_position (product_id, position) DEFERRABLE INITIALLY IMMEDIATE`: one image per position; the reorder statement sets it `DEFERRED` for its transaction. Also serves the per-page primary-image read (`DISTINCT ON (product_id) … ORDER BY product_id, position`, spec 06 §8.5) and "images of a product".
- `idx_product_images_variant_id (variant_id) WHERE variant_id IS NOT NULL`: untie images when a variant is deleted.
- **D-15 (v2.2):** `categories`: `fk_categories_image_media_id` (`RESTRICT`) and `chk_categories_image_alt_text` (alt text only with an image). `uq_categories_image_media_id` and `uq_product_images_media_id` also serve the media cleanup's `RESTRICT` checks, so no extra index. `product_images` FKs are named `fk_product_images_product_id`, `_media_id`, `_variant_id`, all `RESTRICT`; `chk_product_images_position`. The two migrations are separate (one concern each); `categories` is small, so its nullable columns and constraints are added in place.

### 14.5 customers, sellers
- `wishlist_items`: `id UUID PK DEFAULT uuidv7()` · `customer_id` fk · `product_id` fk → products · `created_at TIMESTAMPTZ(3) DEFAULT now()` (append-only; no `updated_at`). `uq_wishlist_items_customer_id_product_id` (also the count under the customer lock and the ids endpoint). `idx_wishlist_items_customer_id_created_at_id (customer_id, created_at DESC, id DESC)`: the list. No index on `product_id` (products are soft-deleted, so the `RESTRICT` check never runs).
- `customers`: trigram index `idx_customers_name_trgm USING GIN ((first_name || ' ' || last_name) gin_trgm_ops)`, concurrently: admin customer search by name (spec 20 §3.3). `idx_customers_phone (phone)`: search by phone.
- `users`: `idx_users_email_pattern (email text_pattern_ops)`, concurrently: admin prefix search `email LIKE 'abc%'` (spec 20 §3.3; `uq_users_email` uses the default collation, which can't serve `LIKE`).
- `sellers` += `rating_count INTEGER` (backfill 0), `rating_avg NUMERIC(3,2) null`, `rating_version BIGINT` (backfill 0), CHECKs as on products.

### 14.6 notifications
- `user_notifications`: std columns (`created_at TIMESTAMPTZ(3)`) · `user_id` fk → users · `category VARCHAR(20)` (`orders, shipments, support, promotions`) · `type VARCHAR(40)` (CHECK, spec 13 §8.2 / §8.8 / §8.9 values) · `title VARCHAR(120)` · `body VARCHAR(300)` · `link VARCHAR(300) null` · `source_event_id UUID` · `read_at TIMESTAMPTZ null` · `push_sent_at TIMESTAMPTZ null`.
  - `uq_user_notifications_user_id_source_event_id`: one row per event and recipient.
  - `idx_user_notifications_user_id_created_at_id (user_id, created_at DESC, id DESC)`: the list (and `category` filter on top).
  - `idx_user_notifications_user_id_unread (user_id, created_at DESC, id DESC) WHERE read_at IS NULL`: unread count and `read=false` filter. **D-16 (v2.3):** `id` added, because the `read=false` list is a keyset on `(created_at, id)` (CLAUDE.md §6.3).
  - Constraints: `chk_user_notifications_category`, `_type` (every type of spec 13 §8.2, §8.8, §8.9, NO-16), `_title` / `_body` (non-empty), `_link` (a client route starting with `/`), `fk_user_notifications_user_id` and `fk_notification_preferences_user_id` (`RESTRICT`).
  - `idx_user_notifications_created_at (created_at)`: retention job.
- `notification_preferences`: `user_id` fk + `category` composite PK [SD-8] · `push_enabled BOOLEAN` · `updated_at TIMESTAMPTZ DEFAULT now()`.
- `push_subscriptions`: std columns · `user_id` fk · `endpoint VARCHAR(2048)` (`uq_push_subscriptions_endpoint`, also the upsert target) · `p256dh VARCHAR(100)` · `auth VARCHAR(50)` · `user_agent VARCHAR(200) null` · `last_success_at TIMESTAMPTZ null`. `idx_push_subscriptions_user_id_created_at (user_id, created_at)`: a user's subscriptions, oldest first (the 11th deletes the oldest).
  - **D-17 (v2.4):** the index is `(user_id, created_at, id)` (a stable order for the trim of the 11th) and `chk_push_subscriptions_endpoint` requires `https://`.
- The user FKs are `ON DELETE RESTRICT` (users are never deleted).

### 14.7 support
- `support_tickets`: std columns (`created_at TIMESTAMPTZ(3)`) · `ticket_number VARCHAR(20)` (`uq_`, from `support_ticket_number_seq`) · `opener_user_id` fk → users · `opener_role VARCHAR(10)` (`customer, seller`) · `category VARCHAR(30)` · `subject VARCHAR(150)` · `status VARCHAR(20)` · `order_id UUID null` fk → orders · `seller_order_id UUID null` fk → seller_orders · `assigned_admin_user_id UUID null` fk → users · `last_message_at`, `last_user_message_at`, `last_admin_message_at` `TIMESTAMPTZ(3)` (the first message sets the first two; `last_admin_message_at` null until an admin replies) · `awaiting_admin_since TIMESTAMPTZ(3) null` · `sla_breached_at`, `resolved_at`, `closed_at` `TIMESTAMPTZ null`.
  - `idx_support_tickets_opener_user_id_last_message_at_id (opener_user_id, last_message_at DESC, id DESC)`: the user's list (+ the open-ticket count with a status filter on few rows).
  - `idx_support_tickets_status_last_message_at_id (status, last_message_at DESC, id DESC)`: admin list by status.
  - `idx_support_tickets_last_message_at_id (last_message_at DESC, id DESC)`: unfiltered admin list.
  - `idx_support_tickets_awaiting_admin_since_id (awaiting_admin_since, id) WHERE status IN ('open','awaiting_admin')`: the oldest-waiting queue and the SLA job.
  - `idx_support_tickets_assigned_admin_user_id (assigned_admin_user_id, last_message_at DESC, id DESC) WHERE assigned_admin_user_id IS NOT NULL`: "my tickets".
  - `idx_support_tickets_resolved_at (resolved_at) WHERE status = 'resolved'`: auto-close job.
  - No index on `order_id` / `seller_order_id` (no lookup by order; orders are never deleted).
- `support_messages`: append-only columns (`created_at TIMESTAMPTZ(3)`) · `ticket_id` fk · `kind VARCHAR(20)` (`message, internal_note, system`) · `sender_user_id UUID null` (null ⇔ `system`, CHECK) · `sender_role VARCHAR(10)` · `body VARCHAR(4000)`. `idx_support_messages_ticket_id_created_at_id (ticket_id, created_at DESC, id DESC)`: the message list.
- `support_message_attachments`: `message_id` fk · `media_id` fk → media_objects (`uq_`) · `position SMALLINT CHECK (BETWEEN 0 AND 2)`; PK (`message_id`, `position`) [SD-8].
- `support_ticket_reads`: (`ticket_id`, `user_id`) PK [SD-8] · `last_read_at TIMESTAMPTZ`.

### 14.8 reviews
- `product_reviews`: std columns (`created_at TIMESTAMPTZ(3)`) · `product_id` fk · `seller_id` fk · `customer_id` fk · `order_item_id` fk → order_items · `variant_id` fk · `rating SMALLINT CHECK (BETWEEN 1 AND 5)` · `title VARCHAR(120) null` · `body TEXT null` (`CHECK (char_length(body) <= 2000)`) · `status VARCHAR(20)` (`published, hidden`) · `hidden_reason VARCHAR(500) null`, `hidden_by_user_id UUID null`, `hidden_at TIMESTAMPTZ null` (all set ⇔ `hidden`) · `edited_at`, `deleted_at` `TIMESTAMPTZ null`.
  - `uq_product_reviews_customer_id_product_id (customer_id, product_id) WHERE deleted_at IS NULL` (RV-1); also "has the customer reviewed these products" for the reviewable list.
  - `idx_product_reviews_product_id_created_at_id (product_id, created_at DESC, id DESC) WHERE status = 'published' AND deleted_at IS NULL`: public list (the `rating` filter / sort reads within one product).
  - `idx_product_reviews_seller_id_created_at_id (seller_id, created_at DESC, id DESC) WHERE status = 'published' AND deleted_at IS NULL`: seller list.
  - `idx_product_reviews_customer_id_created_at_id (customer_id, created_at DESC, id DESC) WHERE deleted_at IS NULL`: "my reviews".
  - `idx_product_reviews_created_at_id (created_at DESC, id DESC) WHERE deleted_at IS NULL`: admin list.
- `review_images`: `review_id` fk · `media_id` fk (`uq_`) · `position SMALLINT CHECK (BETWEEN 0 AND 3)`; PK (`review_id`, `position`).
- `review_replies`: std columns · `review_id` fk (`uq_review_replies_review_id`) · `seller_id` fk · `body VARCHAR(1000)` · `hidden_at TIMESTAMPTZ null`, `hidden_reason VARCHAR(500) null`, `hidden_by_user_id UUID null` (all or none).
- `review_rating_stats`: std columns · `subject_type VARCHAR(10)` (`product, seller`) · `subject_id UUID` (polymorphic, no FK) · `rating_count`, `rating_sum`, `count_1` … `count_5` `INTEGER` · `version BIGINT`. `uq_review_rating_stats_subject_type_subject_id` (the upsert target and the summary read). CHECKs per spec 17 §1.2.

### 14.9 returns
- `return_requests`: std columns (`created_at TIMESTAMPTZ(3)`) · `return_number VARCHAR(20)` (`uq_`, `return_number_seq`) · `seller_order_id` fk · `order_id` fk · `customer_id` fk · `seller_id` fk · `status VARCHAR(20)` · `reason VARCHAR(30)` · `description VARCHAR(1000) null` · `return_fee money` · `return_fee_payer VARCHAR(10)` · `agent_share_rate rate` · `refund_amount money` · `refund_payout_method VARCHAR(20) null` · `refund_payout_encrypted TEXT null` (`CHECK (char_length(...) <= 1000)`; ciphertext, cleared at the end) · `agent_id UUID null` fk → delivery_agents · `rejection_reason VARCHAR(500) null` · `refusal_reason VARCHAR(20) null` · `escalation_note VARCHAR(500) null` · `dispute_reason VARCHAR(500) null` · deadlines `seller_decision_deadline_at`, `escalation_deadline_at`, `inspection_deadline_at` `TIMESTAMPTZ null` · `approved_at`, `received_at`, `completed_at` `TIMESTAMPTZ null`.
  - `uq_return_requests_seller_order_id_open (seller_order_id) WHERE status IN ('requested','rejected','escalated','approved','picked_up','received','disputed')`: one open return (RE-1); also `getOpenReturnSellerOrderIds` (with the escalation deadline check on the few `rejected` rows).
  - `idx_return_requests_customer_id_created_at_id`, `idx_return_requests_seller_id_created_at_id`, `idx_return_requests_created_at_id` (each `… created_at DESC, id DESC`): customer, seller and admin lists.
  - `idx_return_requests_seller_decision (seller_decision_deadline_at) WHERE status = 'requested'`, `idx_return_requests_escalation (escalation_deadline_at) WHERE status = 'rejected'`, `idx_return_requests_inspection (inspection_deadline_at) WHERE status = 'received'`: the three jobs.
- `return_items`: std columns · `return_id` fk · `order_item_id` fk · `quantity SMALLINT CHECK (BETWEEN 1 AND 99)` · `restock BOOLEAN null` (set at completion). `uq_return_items_return_id_order_item_id`.
- `return_photos`: `return_id` fk · `media_id` fk (`uq_`) · `uploaded_by VARCHAR(10)` (`customer, seller`) · `position SMALLINT`; PK (`return_id`, `uploaded_by`, `position`).
- `return_status_history`: same shape as the order histories, index `(return_id, created_at)`.

### 14.10 promotions
- `coupons`: std columns (`created_at TIMESTAMPTZ(3)`) · `code VARCHAR(32)` (`uq_coupons_code`; stored upper-case, `CHECK (code = upper(code))`) · `funding VARCHAR(10)` · `seller_id UUID null` fk · `discount_type VARCHAR(10)` · `discount_value NUMERIC(12,4)` (rate or money by type, CHECKs) · `max_discount NUMERIC(12,2) null` · `min_items_subtotal money` · `scope VARCHAR(10)` · `scope_seller_id UUID null` fk → sellers · `scope_category_id UUID null` fk → categories · `starts_at`, `ends_at` `TIMESTAMPTZ` (`CHECK (starts_at < ends_at)`) · `global_limit INTEGER null` · `per_customer_limit SMALLINT` · `redemption_count INTEGER` (`CHECK (redemption_count >= 0 AND (global_limit IS NULL OR redemption_count <= global_limit))`) · `status VARCHAR(10)` · `first_redeemed_at TIMESTAMPTZ null` (locks the fields, PR-8).
  - `idx_coupons_seller_id_created_at_id (seller_id, created_at DESC, id DESC) WHERE seller_id IS NOT NULL`: seller list; `idx_coupons_created_at_id (created_at DESC, id DESC)`: admin list.
- `coupon_redemptions`: std columns · `coupon_id` fk · `customer_id` fk · `order_id` fk (`uq_coupon_redemptions_order_id`) · `discount_total money` · `status VARCHAR(10)` (`active, released`) · `released_at TIMESTAMPTZ null` (set ⇔ released).
  - `idx_coupon_redemptions_coupon_id_customer_id (coupon_id, customer_id) WHERE status = 'active'`: the per-customer count.
  - `idx_coupon_redemptions_coupon_id_created_at (coupon_id, created_at DESC)`: the admin coupon detail.

### 14.11 ordering, inventory
- `orders` += `coupon_id UUID null` fk → coupons · `coupon_code VARCHAR(32) null` · `discount_total money` (backfill 0; `chk_orders_discount`: `coupon_id IS NULL ⇒ discount_total = 0`). The dashboard counts seller orders, so `orders` gets no new index.
- `seller_orders` += `discount_amount money` (backfill 0) · `discount_funding VARCHAR(10) null` (set ⇔ `discount_amount > 0`) · `returned_subtotal`, `returned_paid`, `returned_commission`, `returned_seller_net` `money` (backfill 0). `cancel_reason` CHECK gains `admin_cancelled`.
  - `idx_seller_orders_placed_at (placed_at) INCLUDE (subtotal, discount_amount, status) WHERE placed_at IS NOT NULL` and `idx_seller_orders_delivered_at (delivered_at) INCLUDE (subtotal, discount_amount, seller_id) WHERE delivered_at IS NOT NULL`, concurrently: dashboard GMV and top sellers over 30 days (spec 20 §3.2).
- `order_items` += `image_media_id UUID null` fk → media_objects, with `idx_order_items_image_media_id (image_media_id) WHERE image_media_id IS NOT NULL` (concurrently): media cleanup deletes `media_objects` rows, and the `RESTRICT` check would otherwise scan `order_items` (DB-Q9) · `returned_quantity INTEGER` (backfill 0) · `discount_original`, `discount_amount` `money` (backfill 0). `chk_order_items_quantities CHECK (cancelled_quantity + returned_quantity <= quantity)` (NOT VALID, then validated).
- `order_item_returns`: append-only columns · `return_id UUID` fk → return_requests `DEFERRABLE INITIALLY DEFERRED` (ordering writes before returns updates its row in the same transaction; the return row already exists, so `IMMEDIATE` would work too, but deferring keeps the write order free) · `order_item_id` fk · `quantity SMALLINT CHECK (> 0)` · `subtotal_amount`, `discount_amount`, `paid_amount`, `commission_amount` `money`. `idx_order_item_returns_order_item_id`.
- `inventory_movements.movement_type` CHECK gains `return_restock`; `reference_type` gains `return`.

### 14.12 payments, delivery
- `payments.status` CHECK expand: + `partially_refunded`, `refunded` (PA-23; the `_manually` values removed in a later release).
- `payment_refunds` += `return_id UUID null` fk → return_requests · `method VARCHAR(20)` (backfill `manual`; `kashier_auto, manual`) · `attempt_count SMALLINT` (backfill 0) · `next_attempt_at TIMESTAMPTZ null` · `last_error VARCHAR(500) null` · `payout_details_encrypted TEXT null` (≤ 1000 chars) · `succeeded_at TIMESTAMPTZ null`. `status` CHECK gains `pending_auto, processing, succeeded`; `reason` gains `return`.
  - `idx_payment_refunds_next_attempt_at_id (next_attempt_at, id) WHERE status = 'pending_auto'`: the refund job; `idx_payment_refunds_processing (updated_at) WHERE status = 'processing'`: stuck check; `idx_payment_refunds_return_id (return_id) WHERE return_id IS NOT NULL`: `getRefundsByReturnIds`. The R1 queue index (`WHERE status = 'pending_manual'`) stays; a new `idx_payment_refunds_status_created_at_id (status, created_at, id)` serves the list over every status.
- `shipments` += `kind VARCHAR(10)` (backfill `delivery`) · `return_id UUID null` fk → return_requests (`uq_shipments_return_id`) · `CHECK ((kind = 'return') = (return_id IS NOT NULL))`. `status` CHECK gains `pickup_failed`. `uq_shipments_seller_order_id` is replaced by `uq_shipments_seller_order_id_delivery (seller_order_id) WHERE kind = 'delivery'` (create the new one concurrently, then drop the old).

### 14.13 finance
- `finance_accounts.account_type` CHECK gains `seller_pending, customer_refund_payable, platform_promotions`; `chk_finance_accounts_balance_non_negative` becomes `account_type IN ('platform_delivery_revenue','platform_promotions','seller_payable') OR balance >= 0` (FI-12, FI-14).
- `ledger_entries.entry_type` and `reference_type` CHECKs gain the spec 12 §8.1 values.
- `seller_order_holds`: `seller_order_id` PK + fk · `seller_id` fk · `held_amount money` · `release_after TIMESTAMPTZ` · `released_at TIMESTAMPTZ null` · `created_at`, `updated_at`. `idx_seller_order_holds_release_after (release_after) WHERE released_at IS NULL`: release job; `idx_seller_order_holds_seller_id_release_after (seller_id, release_after) WHERE released_at IS NULL`: `GET /seller/finance/holds`.

### 14.14 audit
`admin_audit_log` as spec 20 §2.1, with its three indexes and `trg_admin_audit_log_no_update` (`BEFORE UPDATE … RAISE EXCEPTION`). The trigger function lives in the same migration; its `down` drops both.

### 14.15 Decisions (answered 2026-10-20)

The user accepted every recommendation (2026-10-20). The table is kept for the reasoning; the answers are logged in §13 (DB-Q7…DB-Q12).

| # | Topic | Options / recommendation |
|---|---|---|
| DB-Q7 | Adding `NOT NULL` columns to existing tables without a DB default | **Rec:** `ADD COLUMN … NOT NULL DEFAULT v` then `DROP DEFAULT` in the same migration (fast, metadata-only, no default left) · or add nullable, backfill in batches, then `SET NOT NULL` after a validated CHECK (slower, more migrations) |
| DB-Q8 | Admin block vs. the public visibility indexes | **Rec:** a block also sets `status = 'inactive'` and locks the status, so VIS and its seven partial indexes stay unchanged; unblock leaves the product inactive for the seller to re-activate (amends spec 20 §3.4) · or add `admin_blocked_at IS NULL` to VIS and rebuild every VIS index concurrently |
| DB-Q9 | `order_items.image_media_id` index | **Rec:** a partial index, because media cleanup deletes `media_objects` rows and the FK `RESTRICT` check would otherwise scan `order_items` · or no index and accept the scan in a nightly job |
| DB-Q10 | Rating sort inside a category | **Rec:** only the global `idx_products_rating_id` now; a per-category index after measuring · or a `(category_id, COALESCE(rating_avg,0), id)` index from the start |
| DB-Q11 | Encrypted payout details column type | **Rec:** `TEXT` with a length CHECK holding the base64 envelope of the S-1 helper (`iv.tag.ciphertext`) · or `BYTEA` |
| DB-Q12 | Seller orders delivered before R2 | **Rec:** no `seller_order_holds` rows (FI-13); their returns still debit `seller_pending` first, then `seller_payable` (so a pre-R2 return reverses from the available balance) · or a one-off migration creating holds for seller orders delivered in the last 14 days |
