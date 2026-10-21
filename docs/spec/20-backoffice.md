# Spec 20 — back-office and audit

Status: **v1.4 APPROVED (2026-10-21).** v1.4: BO-20…BO-23 the dashboard windows, status index, placed GMV and module edges (§7.2). v1.3: BO-18, BO-19 the directory cursors (§7.2). v1.2: R2-P5 clarifications BO-12…BO-17 (§7.2, every recommendation accepted). v1.1: R2-P1 implementation clarifications BO-9…BO-11 (§7.1, confirmed 2026-10-20). Changes from now on need explicit approval and a version bump. Release 2. Inputs: `00-overview.md` v2.0 §10.4 (admin back-office and audit), R-19, S-9 (answered for R2), spec 09 v2.0 §8.4 (admin cancellation), spec 16 SU-5. §7 BO-1…BO-8 answered 2026-10-20 (every recommendation accepted).
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Two new modules:
1. **`audit`**: an append-only log of every admin write and every `seed-admin` run (R-19), written **in the same transaction as the change**. Table: `admin_audit_log`. Depends on nothing; every module with admin writes depends on it (a leaf, so no cycles).
2. **`backoffice`**: read-only admin views that span modules: the dashboard (§3.2) and the user directory (§3.3). No tables (BO-1). Depends on the public APIs of identity, customers, sellers, ordering, support, finance, delivery and (from spec 18) returns. Nothing depends on it.

The admin actions themselves stay in their owning modules: order cancellation in ordering (spec 09 §8.4), review hiding in reviews (spec 17), the product block in catalog (§3.4, BO-6).

## 2. Audit

### 2.1 Table `admin_audit_log`
| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` v7 PK | |
| `actor_type` | `VARCHAR(10)` | `AuditActorType`: `admin, cli` (CHECK) |
| `actor_user_id` | `UUID NULL` | FK → `users` `RESTRICT`. `null` only for `cli` (CHECK `chk_admin_audit_log_actor`) |
| `action` | `VARCHAR(60)` | `AuditAction` (§2.3), CHECK whitelist; each new action is a migration |
| `target_type` | `VARCHAR(30)` | `AuditTargetType`: `user, seller, category, attribute, option, product, governorate, setting, delivery_agent, shipment, order, seller_order, payment_refund, cod_remittance, payout, support_ticket, review, review_reply` (CHECK) |
| `target_id` | `UUID NULL` | `null` for settings (the `action` names the setting). No FK: the target is polymorphic (P7-Q3 pattern) |
| `changes` | `JSONB NULL` | `{ before: {…}, after: {…} }` of the **allow-listed fields** of that action only (§2.2). CHECK `pg_column_size(changes) <= 8192` |
| `reason` | `VARCHAR(500) NULL` | The reason the admin typed, when the action has one |
| `correlation_id` | `UUID NULL` | From the request context (G26); the CLI generates one per run |
| `ip` | `INET NULL` | Client IP as resolved by `trust proxy` (`null` for the CLI) |
| `created_at` | `TIMESTAMPTZ(3)` | Cursor-sorted (D-11). No `updated_at`: rows never change |

- **Append-only:** a trigger `trg_admin_audit_log_no_update` raises on every `UPDATE`. `DELETE` is used only by the retention job (§2.4) (BO-2).
- Indexes (each for a documented list, §2.5): `(created_at DESC, id DESC)`; `(target_type, target_id, created_at DESC, id DESC)`; `(actor_user_id, created_at DESC, id DESC)`.

### 2.2 Writing (public API, `index.ts`)
| Method | Caller | Notes |
|---|---|---|
| `record(entry, trx) → void` | every module with admin writes, the `seed-admin` CLI | `trx` is **required**: the row commits or rolls back with the change. One insert, no other reads |

```ts
interface AuditEntry {
  action: AuditAction; targetType: AuditTargetType; targetId: string | null;
  before?: Record<string, AuditValue>; after?: Record<string, AuditValue>;   // allow-listed fields only
  reason?: string;
}
type AuditValue = string | number | boolean | null;   // money and rates as strings
```
- The actor, correlation id and IP come from the request context (AsyncLocalStorage), never from the caller's arguments, so a module can't forge them. The api's auth middleware stores the admin's user id and the client IP in the context; the CLI sets `actor_type = cli`.
- **Allow-list per action:** each action's fields are declared next to the `AuditAction` value (a typed map in `app/audit/actions.ts`); `record` drops anything else and logs a `warn AUDIT_FIELD_DROPPED` with the field name (never the value). Secrets never appear in an allow-list: no passwords, tokens, OTPs, invite URLs, API keys, payout bank details.
- `before` / `after` hold only the fields that changed. A create has only `after`, a delete only `before`.
- A failing audit insert fails the whole admin action (it is the same transaction). That is intended: no unaudited admin write.

### 2.3 Audited actions (R-19)
| Module | Endpoint | `action` | Fields / reason |
|---|---|---|---|
| identity | `POST /admin/admins` | `admin.invited` | after: `email`, `role` |
| identity | `POST /admin/users/:id/resend-invite` | `user.invite_resent` | – |
| identity | `POST /admin/users/:id/suspend` · `/reactivate` | `user.suspended` · `user.reactivated` | `status`; reason (suspend). Replaces the I-9 log-only reason as the record of truth; the log line stays |
| identity (CLI) | `seed-admin` | `admin.seeded` | after: `email` (actor `cli`) |
| sellers | approve · reject · suspend · reinstate | `seller.approved` · `seller.rejected` · `seller.suspended` · `seller.reinstated` | `status`; reason |
| sellers | `PUT /admin/sellers/:id/commission-rate` | `seller.commission_changed` | `commissionRate` |
| sellers | `PUT /admin/settings/commission` | `setting.default_commission_changed` | `defaultCommissionRate` |
| catalog | categories create · update | `category.created` · `category.updated` | `name`, `slug`, `sortOrder`, `isActive`, `parentId` |
| catalog | category image set · remove | `category.image_set` · `category.image_removed` | `imageMediaId`, `imageAltText` |
| catalog | attributes create · update · delete | `attribute.created` · `attribute.updated` · `attribute.deleted` | `name`, `code`, `sortOrder`, `categoryId` |
| catalog | options create · update · delete | `option.created` · `option.updated` · `option.deleted` | `value`, `code`, `sortOrder`, `attributeId` |
| catalog | product block · unblock (§3.4) | `product.blocked` · `product.unblocked` | `adminBlocked`; reason |
| delivery | `PATCH /admin/governorates/:id` | `governorate.updated` | `deliveryFee` |
| delivery | `PUT /admin/settings/delivery` | `setting.delivery_changed` | `agentFeeShareRate` |
| delivery | agents create · update · deactivate · activate | `delivery_agent.created` · `.updated` · `.deactivated` · `.activated` | `fullName`, `phone`, `homeGovernorateId`, `status` |
| delivery | `POST /admin/shipments/:id/assign` | `shipment.admin_assigned` | `agentId` |
| ordering | admin cancels (spec 09 §8.4) | `seller_order.admin_cancelled` · `order.admin_cancelled` | `status`; reason |
| payments | `POST /admin/payments/refunds/:id/record` | `payment_refund.recorded` | `status`, `providerRefundRef` |
| finance | remittance · payout | `cod_remittance.recorded` · `payout.recorded` | `amount`, `agentId` / `payeeType` + `payeeId`, `externalReference` |
| support | assign · resolve · close (SU-5) | `support_ticket.assigned` · `.resolved` · `.closed` | `assignedAdminUserId`, `status` |
| reviews | hide · unhide, reply hide · unhide | `review.hidden` · `review.unhidden` · `review_reply.hidden` · `review_reply.unhidden` | `status` / `hidden`; reason |

Added 2026-10-20 from specs 10, 18, 19:

| Module | Endpoint | `action` | Fields / reason |
|---|---|---|---|
| returns | `POST /admin/returns/:id/decide` | `return.admin_decided` | `status`; note |
| returns | `POST /admin/returns/:id/resolve-dispute` | `return.dispute_resolved` | `status`, `decision`; note |
| payments | `POST /admin/payments/refunds/:id/retry` | `payment_refund.retried` | `status` |
| promotions | `POST /admin/coupons` · `PATCH /admin/coupons/:id` | `coupon.created` · `coupon.updated` | every coupon field except counters |

`target_type` gains `return_request`, `coupon`. The COD refund recording uses the existing `payment_refund.recorded` row; payout details are never in `changes`. Admin **reads** are not audited (BO-3). Admin support messages and notes are not audited (SU-5).

### 2.4 Retention job (worker, advisory-locked, every `JOB_AUDIT_RETENTION_INTERVAL_MS`)
Deletes rows with `created_at < now() − AUDIT_RETENTION_DAYS` (730, R-19) in batches of `AUDIT_RETENTION_BATCH_SIZE` (`DELETE … WHERE id IN (SELECT id … ORDER BY created_at LIMIT ?)`), one short transaction per batch, until a batch is smaller than the limit.

### 2.5 Endpoints   auth: admin · rate: general
```ts
interface AuditEntryDto {
  id: string; actorType: AuditActorType;
  actor: { userId: string; email: string } | null;     // one batched identity.getUsersByIds call
  action: AuditAction; targetType: AuditTargetType; targetId: string | null;
  changes: { before: Record<string, AuditValue>; after: Record<string, AuditValue> } | null;
  reason: string | null; correlationId: string | null; ip: string | null; createdAt: string;
}
```

| Endpoint | Query | Success | Errors |
|---|---|---|---|
| `GET /admin/audit-log` | whitelist `actorUserId` (uuid, `eq`) · `action` (enum, `eq,in`) · `targetType` (enum, `eq`) · `targetId` (uuid, `eq`; needs `targetType`) · `createdAt` (date, `gte,lte`, sort, default `-createdAt`) | `200 AuditEntryDto[]` + meta | `INVALID_QUERY` 400 (`targetId` without `targetType`) |
| `GET /admin/audit-log/:entryId` | – | `200 AuditEntryDto` | `AUDIT_ENTRY_NOT_FOUND` 404 |

Every admin may read the log; there is one admin role (BO-4).

## 3. Back-office

### 3.1 Business day
Daily figures use the business time zone **`Africa/Cairo`** (a constant, `BUSINESS_TIME_ZONE`), stored data stays UTC (BO-5). A "day" is `[00:00, 24:00)` Cairo time, computed in SQL with `AT TIME ZONE`.

### 3.2 Dashboard (`GET /admin/dashboard`)
Composed by `backoffice` from one stats method per owning module (each one batched query or a few, no N+1); all are reads without locks.

| Block | Source | Content |
|---|---|---|
| `orders` | `ordering.getDashboardStats` | Seller orders by current status (open statuses only); orders placed today and in the last 7 days |
| `gmv` | `ordering.getDashboardStats` | Last 30 business days, per day: **placed GMV** (Σ current `subtotal` of seller orders placed that day, not cancelled) and **delivered GMV** (Σ `subtotal` of seller orders delivered that day) (BO-7) |
| `topSellers` | ordering + `sellers.getSummaries` | Top 10 sellers by delivered GMV over the last 30 days, with business names |
| `sellers` | `sellers` | Count `pending_approval` |
| `support` | `support.getStats` (spec 16 §2) | `open`, `awaitingAdmin`, `slaBreached` |
| `finance` | `finance.getDashboardStats` (new) | COD outstanding: Σ `agent_cod_cash` balances; Σ `seller_payable`; Σ `agent_fee_payable` |
| `delivery` | `delivery.getDashboardStats` (new) | Shipments awaiting assignment; shipments out for delivery |
| `returns` | `returns` (spec 18) | Open returns, by status (added with spec 18) |

```ts
interface DashboardDto {
  generatedAt: string;          // cache time, see below
  orders: { byStatus: Record<SellerOrderStatus, number>; placedToday: number; placedLast7Days: number };
  gmv: { day: string; placed: string; delivered: string }[];      // 'YYYY-MM-DD' Cairo, oldest first
  topSellers: { sellerId: string; businessName: string; deliveredGmv: string }[];
  sellers: { pendingApproval: number };
  support: { open: number; awaitingAdmin: number; slaBreached: number };
  finance: { codOutstanding: string; sellerPayable: string; agentFeePayable: string };
  delivery: { awaitingAssignment: number; outForDelivery: number };
}
```
- Cached in Redis as one value `v1:backoffice:dashboard` for `DASHBOARD_CACHE_TTL_SECONDS` (60). No invalidation: the figures are allowed to be up to a minute old, and `generatedAt` says how old. Redis down → computed fresh (cache-aside, architecture §8).
- The GMV and top-seller queries need indexes on `seller_orders (placed_at)` and `seller_orders (delivered_at)` (partial, `WHERE … IS NOT NULL`, INCLUDE `subtotal, seller_id`) — database v2.0.

### 3.3 User directory
| Endpoint | Module | Query | Success |
|---|---|---|---|
| `GET /admin/users` | identity | whitelist `role` (enum, `eq`) · `status` (enum, `eq,in`) · `email` (text, `like`) · `createdAt` (date, `gte,lte`, sort, default `-createdAt`) | `200 { id, email, role, status, emailVerifiedAt, lastLoginAt, createdAt }[]` + meta |
| `GET /admin/customers` | customers | whitelist `name` (text, `like` on first or last name) · `phone` (text, `eq`) · `createdAt` (sort) | `200 { id, userId, email, firstName, lastName, phone, userStatus, createdAt }[]` + meta (emails and statuses from one batched identity call) |
| `GET /admin/customers/:customerId` | customers | – | `200` the same + `addressCount`; the customer's orders come from `GET /admin/orders?customerId[eq]=` (spec 09 §4.3) |

- `email` `like` is a **prefix** match served by a `text_pattern_ops` index on `users.email`; customer names by a trigram index (database v2.0). Sellers and agents keep their own admin lists (specs 05, 11).
- Errors: `CUSTOMER_NOT_FOUND` 404 (new, customers).

### 3.4 Product block (catalog, BO-6)
An admin can take a product off the shop (counterfeit, prohibited goods), whatever its status.
- New columns `products.admin_blocked_at TIMESTAMPTZ NULL`, `admin_block_reason VARCHAR(500) NULL` (`CHECK` both null or both set).
- A block also sets `status = 'inactive'` (database DB-Q8, 2026-10-20), so the product leaves the shop through the existing visibility rule and no public index changes. It can't be bought (`getVariantsForPurchase` → not purchasable, so cart shows an issue and checkout answers `CART_HAS_ISSUES`), and the seller can't change its status while blocked (`409 PRODUCT_BLOCKED`). The seller sees `adminBlocked: true` and the reason.
- **Unblock** clears the two columns and leaves the product `inactive`; the seller re-activates it.
- Open orders of the product continue (like Q-36).
- Endpoints (auth: admin): `POST /admin/products/:productId/block` (`reason str(3..500)`) and `POST /admin/products/:productId/unblock` → `200` admin product view (`GET /admin/products/:productId`, new: the seller product detail + seller id). Errors: `PRODUCT_NOT_FOUND` 404, `PRODUCT_BLOCK_INVALID_STATUS` 409 (block a blocked one, unblock an unblocked one).
- Each writes an audit row and deletes the product-detail cache after commit (CA-8). The seller is notified in-app (`orders` category, BO-8).

## 4. Endpoints
Listed in §2.5 and §3. All are admin-only, rate class `general`, no `Idempotency-Key` (no money or stock effect; block / unblock are guarded by the current state).

## 5. Events
Published: `product.blocked` (catalog; `{ productId, sellerId, at }`, spec 02 §6.4) → notifications (seller); `product.unblocked` (same payload), consumed by nobody in R2 (BO-14). Audit and backoffice publish nothing.
Consumed: none.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `AUDIT_ENTRY_NOT_FOUND` | 404 | |
| `CUSTOMER_NOT_FOUND` | 404 | Admin customer detail |
| `PRODUCT_BLOCKED` | 409 | A seller status change on a blocked product (catalog) |
| `PRODUCT_BLOCK_INVALID_STATUS` | 409 | Block a blocked product, unblock an unblocked one (catalog) |

Log codes: `AUDIT_FIELD_DROPPED` (warn).
Config, no defaults: worker `AUDIT_RETENTION_DAYS`, `JOB_AUDIT_RETENTION_INTERVAL_MS`, `AUDIT_RETENTION_BATCH_SIZE`; api `DASHBOARD_CACHE_TTL_SECONDS`.

## 7. Decisions (answered 2026-10-20)

The user accepted every recommendation (2026-10-20). The table is kept for the reasoning; the answers are logged in `00-overview.md` §10.10.

| # | Topic | Options / recommendation |
|---|---|---|
| BO-1 | Where cross-module admin views live | **Rec:** a table-less `backoffice` module that composes public APIs (one call and one cache for the dashboard) · or one stats endpoint per module and the web client composes them |
| BO-2 | How "append-only" is enforced | **Rec:** a trigger that rejects `UPDATE`; `DELETE` only by the retention job (one DB role, so the trigger is the guard against mistakes, not against a compromised app) · or a separate DB role without `UPDATE`/`DELETE` on the table (more ops work; the retention job then needs its own role) |
| BO-3 | Auditing admin reads of personal data | **Rec:** not in R2 (writes only, R-19) · or log admin views of customer details too |
| BO-4 | Who may read the audit log | **Rec:** every admin (one admin role, overview §2) · or a new "super admin" flag |
| BO-5 | Day boundaries for the dashboard | **Rec:** `Africa/Cairo` business days · or UTC days |
| BO-6 | Admin product block (not in the overview §10.4 list) | **Rec:** add it to R2 (§3.4): a marketplace needs a way to take down a prohibited product without suspending the whole seller; small (two columns, two endpoints) · or leave it out (admins can only suspend the seller) |
| BO-7 | GMV definition | **Rec:** show both placed GMV (current subtotals of seller orders placed that day, cancellations excluded) and delivered GMV (subtotals delivered that day); returns (spec 18) reduce delivered GMV on the day the return is received · or delivered GMV only |
| BO-8 | Notify the seller of a block | **Rec:** in-app + push under `orders` ("A product was blocked by the platform"), with the reason only in the seller's product view · or no notification |

### 7.1 Clarifications (R2-P1 implementation, confirmed 2026-10-20)

| # | Clarification | Where |
|---|---|---|
| BO-9 | The audit **contract** (`IAuditRecorder`, `AuditEntry` and the action catalogue with each action's target type and allow-list) lives in the shared kernel `lib/audit`, like the event contracts in `lib/events`. Modules record through `TOKENS.AuditRecorder` and never import the audit module, so audit itself may call identity for the actor emails of §2.5 without a cycle (architecture v2.1 §14.2) | §2.2, §2.5 |
| BO-10 | `AuditEntry` carries no `targetType`: it follows from the action (`seller.approved` → `seller`), so a caller can't pair an action with the wrong target. An update whose recorded fields didn't change stores `changes = null` | §2.2 |
| BO-11 | `actor_user_id` is a foreign key to `users`: an admin write with a token whose user doesn't exist fails (422). Real tokens always have a user; only synthetic test tokens hit it | §2.1 |

### 7.2 Clarifications (R2-P5 implementation, approved 2026-10-21)

| # | Clarification | Where |
|---|---|---|
| BO-12 | `seller_orders` has no `placed_at`: "placed GMV" and "orders placed" use `orders.placed_at`, joined to the seller orders inside ordering. `idx_orders_placed_at (placed_at) WHERE placed_at IS NOT NULL`, built concurrently, replaces the design's `idx_seller_orders_placed_at` (database D-20); no new column, which would need a backfill `UPDATE` of a live table | §3.2 |
| BO-13 | `orders.byStatus` counts the seller orders in every non-terminal status: `pending_payment`, `placed`, `accepted`, `ready_for_pickup`, `picked_up`, `out_for_delivery`, `delivery_failed`, `returning_to_seller`; `delivered`, `cancelled`, `returned_to_seller` are left out | §3.2 |
| BO-14 | The block events carry spec 02's payload `{ productId, sellerId, at }`. The `product_blocked` notification links to `/seller/products/<productId>` (spec 13 NO-33). `product.unblocked` notifies nobody: it is published, and nothing consumes it in R2 (spec 02 v1.3) | §3.4, §5 |
| BO-15 | A blocked product refuses only activation (`409 PRODUCT_BLOCKED`); the seller may still edit its fields, variants, images and stock, and delete it, to fix the listing | §3.4 |
| BO-16 | A block moves an `active` product to `inactive`; a draft or an inactive product keeps its status (the block columns refuse activation either way). Blocking or unblocking a deleted product → `404 PRODUCT_NOT_FOUND` | §3.4 |
| BO-17 | `GET /admin/users` is new in identity (R1 has only `/admin/admins`); `emailVerifiedAt` and `lastLoginAt` are existing columns; the email prefix filter is served by `idx_users_email_pattern` | §3.3 |
| BO-18 | `customers.created_at` becomes `TIMESTAMPTZ(3)`, the cursor precision (CLAUDE.md §6.2, D-11); the rewrite is harmless before the first deployment. `users.created_at` already is (D-11) | §3.3 |
| BO-19 | Both directories page on `(created_at, id)` with no filter required: `idx_users_created_at_id` and `idx_customers_created_at_id (created_at DESC, id DESC)`, concurrently (database D-21); `idx_users_role_created_at` serves only role-filtered pages | §3.3 |
| BO-20 | Every window ends today (Cairo), today included: `gmv` is the 30 days ending today, zero-filled, oldest first; `placedToday` is today; `placedLast7Days` is today and the 6 days before; `topSellers` uses the same 30 days as `gmv` | §3.2 |
| BO-21 | `orders.byStatus` is served by `idx_seller_orders_open_status (status) WHERE status IN (<the 8 open statuses>)`, concurrently (database D-22) | §3.2 |
| BO-22 | Placed GMV counts every seller order of an order placed that day except `cancelled` ones (a failed delivery returned to the seller still counts); orders awaiting payment have no `placed_at` and count nowhere | §3.2 |
| BO-23 | `backoffice` imports only the modules the dashboard reads: ordering, sellers, support, finance, delivery (returns joins in R2-P6); the user directory lives in identity and customers (architecture v2.4) | §3.2 |
