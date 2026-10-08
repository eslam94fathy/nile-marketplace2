# System Design 02 — Database Schema (Release 1)

Status: **v1.1 APPROVED (2026-10-08).** v1.1: COD payment status `cancelled` added (D-1, S-12). Changes from now on need explicit approval and a version bump. Decisions: §13.
Engine: PostgreSQL 18, single `public` schema. Engineering rules: `CLAUDE.md` §6. Business rules: `docs/spec/00-overview.md` v1.0.

---

## 0. Conventions used in this document

- **std columns** = `id UUID PRIMARY KEY DEFAULT uuidv7()`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Repositories set `updated_at = now()` on every update.
- **append-only columns** = `id UUID PRIMARY KEY DEFAULT uuidv7()`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. No `updated_at`; rows are never updated.
- Every column is **NOT NULL** unless marked `null`. **No other DEFAULTs.**
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

### refresh_tokens
| column | type | rules |
|---|---|---|
| append-only columns | | (+ `revoked_at`, set once) |
| user_id | UUID | `fk_refresh_tokens_user_id` → users, `ON DELETE CASCADE` |
| family_id | UUID | all rotations of one login share a family |
| token_hash | CHAR(64) | SHA-256 hex of the opaque token |
| expires_at | TIMESTAMPTZ | |
| revoked_at | TIMESTAMPTZ null | |
| replaced_by_id | UUID null | `fk_refresh_tokens_replaced_by_id` → refresh_tokens |
| user_agent | VARCHAR(255) null | for "active sessions" auditing |

Indexes:
- `uq_refresh_tokens_token_hash (token_hash)`: the refresh lookup.
- `idx_refresh_tokens_family_id (family_id)`: revoke the whole family on reuse.
- `idx_refresh_tokens_user_id (user_id) WHERE revoked_at IS NULL`: revoke all sessions on suspend or password reset.

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
- `idx_products_category_id_created_at_id (category_id, created_at DESC, id DESC) WHERE VIS`: category listing, newest first.
- `idx_products_category_id_min_price_id (category_id, min_price, id) WHERE VIS`: category listing sorted or filtered by price.
- `idx_products_created_at_id (created_at DESC, id DESC) WHERE VIS`: listing without a category filter.
- `idx_products_search_vector USING GIN (search_vector) WHERE VIS`: full-text search.
- `idx_products_name_trgm USING GIN (name gin_trgm_ops) WHERE VIS`: typo-tolerant / partial-word search.
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
std columns · `inventory_item_id` fk · `order_item_id` fk → order_items · `quantity INTEGER CHECK (quantity > 0)` · `status VARCHAR(20)` (`active, committed, released`).
- `uq_inventory_reservations_order_item_id (order_item_id)`: one reservation per order line. Also the commit/release lookup.
- Partial item cancellation lowers `quantity` and releases the difference, with a movement row.

### inventory_movements (append-only, audit)
`inventory_item_id` fk · `type VARCHAR(30)` (`seller_adjustment, reserve, release, commit`) · `quantity_delta INTEGER` · `on_hand_after INTEGER` · `reserved_after INTEGER` · `reference_type VARCHAR(30) null` · `reference_id UUID null` · `actor_user_id UUID null`.
Index: `idx_inventory_movements_inventory_item_id_created_at (inventory_item_id, created_at DESC)`: seller stock history.

---

## 7. cart

### carts
std columns · `customer_id` fk → customers. `uq_carts_customer_id`: one cart per customer, the lookup path.

### cart_items
std columns · `cart_id` fk `ON DELETE CASCADE` · `variant_id` fk → product_variants · `quantity INTEGER CHECK (quantity BETWEEN 1 AND 99)` [DB-Q3]. Max **50** distinct lines per cart, enforced by the app (config).
`uq_cart_items_cart_id_variant_id (cart_id, variant_id)`: one line per variant, and serves "items of my cart".

---

## 8. ordering

### orders
| column | type | rules |
|---|---|---|
| std columns | | |
| order_number | VARCHAR(20) | `'NM-' \|\| lpad(nextval('order_number_seq')::text, 9, '0')`, set explicitly in the INSERT [SD-10] |
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

### order_item_cancellations (append-only)
`order_item_id` fk · `quantity INTEGER CHECK (> 0)` · `reason VARCHAR(40)` (`out_of_stock, seller_request, other`) · `note VARCHAR(500) null` · `actor_user_id` fk → users.
Index: `idx_order_item_cancellations_order_item_id (order_item_id)`.

### order_status_history / seller_order_status_history (append-only)
`order_id` (or `seller_order_id`) fk · `from_status VARCHAR(30) null` · `to_status VARCHAR(30)` · `actor_role VARCHAR(20)` (`customer, seller, admin, delivery_agent, system`) · `actor_user_id UUID null` · `reason VARCHAR(500) null`.
Index: `(order_id | seller_order_id, created_at)`: timeline view.

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
| provider_order_ref | VARCHAR(100) null | the Kashier order/session id |
| provider_transaction_ref | VARCHAR(100) null | the Kashier transaction id |
| paid_at | TIMESTAMPTZ null | |

Indexes:
- `uq_payments_order_id (order_id)`.
- `uq_payments_provider_order_ref (provider_order_ref) WHERE provider_order_ref IS NOT NULL`: webhook → payment lookup.

### payment_refunds
std columns · `payment_id` fk · `seller_order_id UUID null` fk (null = whole order / fee) · `amount money CHECK (> 0)` · `reason VARCHAR(40)` (`seller_order_cancelled, items_cancelled, delivery_failed, late_payment_after_expiry, all_cancelled_fee`) · `status VARCHAR(20)` (`pending_manual, recorded`) · `recorded_by_user_id UUID null` · `recorded_at TIMESTAMPTZ null` · `provider_refund_ref VARCHAR(100) null`.
Indexes:
- `idx_payment_refunds_created_at WHERE status = 'pending_manual'`: the admin refund queue.
- `idx_payment_refunds_payment_id (payment_id)`.

### payment_events (append-only, webhook inbox)
`payment_id UUID null` fk · `provider VARCHAR(20)` (`kashier`) · `provider_event_id VARCHAR(100)` · `event_type VARCHAR(50)` · `payload JSONB` (secrets/card data stripped) · `signature_valid BOOLEAN` · `processed_at TIMESTAMPTZ null`.
`uq_payment_events_provider_provider_event_id (provider, provider_event_id)`: webhook dedupe.

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

### shipments
| column | type | rules |
|---|---|---|
| std columns | | |
| seller_order_id | UUID | fk → seller_orders. `uq_shipments_seller_order_id` (idempotent creation) |
| order_id | UUID | fk → orders (shipments of one checkout: fee split and fee carrier) |
| agent_id | UUID null | fk → delivery_agents |
| status | VARCHAR(30) | `unassigned, assigned, picked_up, out_for_delivery, delivery_failed, returning_to_seller, returned_to_seller, delivered, cancelled` |
| pickup_* / dropoff_* | | address snapshots copied from the event payload (same columns as on orders / seller_orders) |
| cod_items_amount | money | COD: seller order subtotal to collect. Kashier: 0 |
| carries_delivery_fee | BOOLEAN | `true` on the one shipment that collects the COD fee: the first of the checkout to go `out_for_delivery`. Moves to the next shipment going out if this one fails or returns [SD-2, DB-Q1 approved] |
| cod_fee_amount | money | the fee if `carries_delivery_fee`, else 0 |
| cod_collected_amount | NUMERIC(12,2) null | set on delivered |
| agent_fee_share | NUMERIC(12,2) null | set on delivered (equal split, Q-27) |
| attempt_count | SMALLINT | app inserts 0. `CHECK (attempt_count BETWEEN 0 AND 3)` |
| assigned_at, picked_up_at, delivered_at, returned_at | TIMESTAMPTZ null | |

Indexes:
- `uq_shipments_seller_order_id`.
- `idx_shipments_agent_id_status (agent_id, status) WHERE agent_id IS NOT NULL`: the agent's active list, and the "active shipment count" used for assignment.
- `idx_shipments_created_at (created_at) WHERE status = 'unassigned'`: the assignment retry job.
- `idx_shipments_order_id (order_id)`: shipments of one checkout.
- `uq_shipments_order_id_fee_carrier (order_id) WHERE carries_delivery_fee`: **at most one** fee-carrying shipment per checkout.

### shipment_attempts (append-only)
`shipment_id` fk · `attempt_number SMALLINT CHECK (BETWEEN 1 AND 3)` · `reason VARCHAR(30)` (`customer_unreachable, customer_refused, wrong_address, customer_rescheduled`) · `note VARCHAR(500) null` · `agent_id` fk.
`uq_shipment_attempts_shipment_id_attempt_number`: no duplicate attempt numbers, and serves "attempts of a shipment".

### shipment_status_history (append-only)
Same shape as the order histories. Index `(shipment_id, created_at)`.

---

## 11. finance

Balances are stored per account, and every change is an immutable ledger entry written **in the same transaction** as the balance update (row-locked). This gives fast balance reads plus a full audit trail.

### finance_accounts
std columns · `account_type VARCHAR(30)` · `owner_id UUID null` · `balance NUMERIC(14,2)` (signed; `CHECK (balance >= 0)` for payable accounts, enforced per type in the app; see the note below).
`uq_finance_accounts_account_type_owner_id (account_type, owner_id) NULLS NOT DISTINCT`.

Account types:
- `seller_payable` (owner = seller): what the platform owes the seller.
- `agent_fee_payable` (owner = agent): what the platform owes the agent in fee shares.
- `agent_cod_cash` (owner = agent): cash the agent holds that belongs to the platform.
- `platform_commission_revenue`, `platform_delivery_revenue` (owner = null).

### ledger_entries (append-only)
`account_id` fk → finance_accounts · `direction VARCHAR(6)` (`credit, debit`) · `amount money CHECK (> 0)` · `balance_after NUMERIC(14,2)` · `entry_type VARCHAR(40)` (`seller_net_earned, commission_earned, agent_fee_earned, platform_fee_earned, cod_cash_collected, cod_cash_remitted, seller_payout, agent_payout`) · `reference_type VARCHAR(30)` · `reference_id UUID` · `source_event_id UUID null`.
Indexes:
- `idx_ledger_entries_account_id_created_at_id (account_id, created_at DESC, id DESC)`: account statement, cursor-paginated.
- `idx_ledger_entries_reference_type_reference_id (reference_type, reference_id)`: "all money movements of seller order X".

### cod_remittances (append-only)
`agent_id` fk → delivery_agents · `amount money CHECK (> 0)` · `confirmed_by_user_id` fk → users · `note VARCHAR(500) null`.
Index: `idx_cod_remittances_agent_id_created_at (agent_id, created_at DESC)`.

### payouts (append-only)
`payee_type VARCHAR(20)` (`seller, agent`) · `payee_id UUID` · `amount money CHECK (> 0)` · `external_reference VARCHAR(200)` (bank / wallet transfer ref) · `recorded_by_user_id` fk → users · `paid_at TIMESTAMPTZ`.
Index: `idx_payouts_payee_type_payee_id_created_at (payee_type, payee_id, created_at DESC)`.
A payout amount must be ≤ the account balance. This is checked under `SELECT … FOR UPDATE` on the account row.

---

## 12. notifications & shared

### notification_log
std columns · `user_id UUID null` fk · `template VARCHAR(50)` (`email_verification, password_reset, account_invite`) · `to_email VARCHAR(254)` · `status VARCHAR(20)` (`sent, failed`) · `provider_message_id VARCHAR(100) null` · `error VARCHAR(2000) null` · `source_event_id UUID`.
- `uq_notification_log_source_event_id`: never send the same email twice.
- `idx_notification_log_user_id_created_at`: support lookup.
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

No open schema questions.
