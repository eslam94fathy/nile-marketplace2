# Nile Marketplace — Spec Overview (Release 1)

Status: **v1.1 APPROVED (2026-10-08).** v1.0 approved 2026-10-07. v1.1: §7 now points to `02-events.md` (O-3); per-module answers in §9.1. Changes from now on need explicit approval and a version bump.
Legend: **[CONFIRMED]** = decided by the user · **[PROPOSED]** = Claude's proposal, not yet approved · **Q-n** = open question (§8). Answers are logged in §9.

Nothing marked [PROPOSED] may be implemented until it is approved.

---

## 1. Product summary [CONFIRMED]

**Platform & actors**
- Multi-vendor marketplace for a mobile app. Single currency: **EGP**. No invoices/VAT in R1 (Q-19).
- Actors: **customer, seller, admin, delivery agent**. One role per account.
- Login is by **email**. Self-registered accounts must **verify their email** (OTP by email) (Q-21). The only messaging channel in R1 is **email via Mailjet** (Q-14, Q-35). No SMS.
- Admin accounts are **seeded** (CLI/migration), and then admins create other admins. **Delivery-agent accounts are created by admins.** Admin-created accounts receive an **email invite** to set their password; there are no temporary passwords (Q-20, Q-39).

**Sellers**
- Sellers self-register, **verify their email**, and must be **approved by an admin** before they can sell (Q-40). Required at registration: **business name, pickup address (with governorate), contact phone** (Q-5, Q-29). A rejected seller can re-apply after editing the profile (Q-29).
- Commission is set **per seller** (default **10%**). It is calculated on the **item subtotal only** (no delivery fee), and a rate change applies **only to new orders**, because the rate is snapshotted at checkout (Q-6).

**Catalog**
- Categories form a **tree**, max depth **3**. Products can attach to a category at **any level** (not only leaves). Attributes defined on a category are **inherited** by all its descendants (Q-3, Q-30).
- **Admins define attributes per category.** Sellers build variants by picking attribute values (Q-2).
- **Each variant has its own SKU, price and stock** (Q-1).
- Products go live **without admin approval**: the seller publishes them (Q-4c).
- Products and variants are **soft-deleted** (Q-4).
- **No product images in R1** (intended). They come in R2 (Q-4b, Q-42).

**Orders**
- One checkout (cart with many sellers) → one **order**, **split into one seller order per seller**. Order status is **stored** (Q-8).
- The seller must **accept** each seller order. If they don't within **24 h wall-clock**, it is auto-cancelled (Q-7, Q-22, Q-22b).
- **Cancellation** (Q-10):
  - The customer can cancel before the seller accepts.
  - The seller can cancel.
  - **Partial cancellation:** only the **seller** can cancel individual items/quantities. The seller can cancel items or the whole seller order **before `picked_up`**. The customer can cancel only **whole seller orders**, and only while they are still `placed` (Q-31).

**Payments**
- Payment is **COD** or **Kashier**. **One Kashier payment covers the whole checkout** (Q-9).
- An unpaid Kashier checkout holds stock for **15 min** (Q-12).
- Cancelling an online-paid order means an admin refunds manually in the Kashier dashboard, and the system records it as `refunded_manually`.

**Delivery**
- In-house delivery agents use **direct pickup**: from the seller's address straight to the customer. No hub. **One shipment per seller order** (Q-17).
- Agents are **assigned automatically** by the algorithm in §4.6 (Q-12b, Q-32). Agents **cannot reject** an assignment; only an admin can reassign (Q-41).
- A shipment gets **up to 3 delivery attempts**, then it returns to the seller per §4.7 (Q-13, Q-33).
- **Coverage** is kept simple: no zones (Q-16). Only governorates with a configured fee are deliverable, and checkout to any other governorate is rejected (Q-26).

**Delivery fee**
- Set by an admin **per governorate** (the customer address governorate) and **charged once per checkout** (Q-15, Q-24).
- Split **70% agent / 30% platform**: one **global** admin-configurable setting, snapshotted per order (Q-23b, Q-34). The seller gets none of it. Agents are **not salaried**: their fee shares are paid out by an admin outside the system, like seller payouts (Q-38).
- The agent share is split **equally among the checkout's shipments** (Q-27).
- If only some seller orders are cancelled, the full fee is still charged. If **all** are cancelled, there's no fee: nothing is collected for COD, and for Kashier the fee is included in the manual refund (Q-28).

**Money flow & payouts**
- COD cash flows **agent → platform → seller (minus commission)**. Agents hand over cash, and an **admin confirms receipt** in the system (Q-18).
- The seller net is credited to the seller balance on `delivered` (a holding period comes in R2, Q-25).
- **Admins pay sellers outside the system** and record the payout (Q-11).

## 2. Modules (bounded contexts) [CONFIRMED]

| Module | Owns (tables) | Responsibility in R1 |
|---|---|---|
| `identity` | `users`, `refresh_tokens`, `otp_codes` | Registration (customer, seller), email verification OTP, login (email + password), refresh rotation, logout, password reset via email OTP, admin seeding CLI, admin-created accounts (admins, agents) |
| `customers` | `customers`, `customer_addresses` | Customer profile and delivery addresses (with governorate) |
| `sellers` | `sellers`, `seller_commission_history` | Seller profile (business name, …: Q-29), approval lifecycle, per-seller commission rate + history |
| `catalog` | `categories`, `category_attributes`, `category_attribute_options`, `products`, `product_variants`, `variant_attribute_values` | Category tree, admin-defined attributes, seller products/variants (price per variant), soft delete, search & filters (Postgres FTS + `pg_trgm`) |
| `inventory` | `inventory_items`, `inventory_reservations` | Stock per variant, reserve / commit / release, 15-min reservation expiry for unpaid Kashier checkouts |
| `cart` | `carts`, `cart_items` | One active cart per customer, price/stock re-validation at checkout |
| `ordering` | `orders`, `seller_orders`, `order_items`, `order_status_history` | Checkout, split per seller, snapshots, stored statuses, cancellation (full + partial), 24 h acceptance timeout |
| `payments` | `payments`, `payment_events` | COD and Kashier payments, Kashier webhook (signature-verified, idempotent), manual-refund recording |
| `delivery` | `governorates`, `delivery_agents`, `shipments`, `shipment_attempts`, `shipment_status_history` | Governorate fees, agent profiles + availability, automatic assignment, attempts (max 3), returns to seller, COD collection |
| `finance` | `ledger_entries`, `cod_remittances`, `seller_payouts` | Double-entry style ledger: commission, seller balances, agent fee shares, COD cash owed by agents, admin-confirmed remittances, manual payouts |
| `notifications` (minimal) | `notification_log` | Transactional email only: verification OTP, password reset OTP, account invites via **Mailjet** (Q-35) |
| `health` | n/a | live / ready probes |

- Admin endpoints are **not** a separate module. Each module exposes its own admin routes under `/api/v1/admin/...`, guarded by the admin role.
- Role profile tables reference `users.id` (G12): `customers.user_id`, `sellers.user_id`, `delivery_agents.user_id`.

## 3. Key entities and relationships [CONFIRMED]

```
users 1─1 customers 1─* customer_addresses ─→ governorates
users 1─1 sellers   1─* products 1─* product_variants 1─1 inventory_items
users 1─1 delivery_agents
seller_commission_history *─1 sellers

categories (tree: parent_id) 1─* categories
categories 1─* category_attributes 1─* category_attribute_options
categories 1─* products
product_variants *─* category_attribute_options      (via variant_attribute_values)

carts (1 active per customer) 1─* cart_items ─→ product_variants

orders (checkout) 1─* seller_orders (one per seller) 1─* order_items ─→ product_variants
orders 1─1 payments                                   (one payment per checkout)
seller_orders 1─1 shipments ─→ delivery_agents
shipments 1─* shipment_attempts                       (max 3)
```

**Snapshots at checkout**, so later edits never rewrite history:
- `order_items`: product name, variant attribute values, SKU, unit price, quantity, line total, cancelled quantity.
- `seller_orders`: commission rate, subtotal, commission, seller net, pickup address.
- `orders`: delivery address + governorate, delivery fee, agent share %, items total, grand total.

## 4. Lifecycles (state machines) [CONFIRMED]

### 4.1 Seller
`pending_approval → approved | rejected`; `approved ⇄ suspended`. `rejected → pending_approval` when the seller edits the profile and re-applies [CONFIRMED]. Approval also requires a verified email [CONFIRMED Q-40].
Only `approved` sellers' products are visible and purchasable. Suspending a seller hides their products. Their open seller orders **continue** to completion [CONFIRMED Q-36].

### 4.2 Product / variant
`draft → active ⇄ inactive`. Soft delete (`deleted_at`) at any state [CONFIRMED soft delete]. A product needs ≥1 active variant to be `active`. Deleted products stay readable in past orders through the snapshots.

### 4.3 Order and seller order (statuses stored [CONFIRMED])

`seller_orders.status`:
```
pending_payment (Kashier only, ≤15 min) ─→ placed            (payment confirmed / COD)
pending_payment ─→ cancelled                                (payment failed / expired → stock released)
placed ─→ accepted ─→ ready_for_pickup ─→ picked_up ─→ out_for_delivery ─→ delivered
placed ─→ cancelled   by customer [CONFIRMED], by seller [CONFIRMED], or by timeout after 24 h [CONFIRMED]
accepted | ready_for_pickup ─→ cancelled   by seller [CONFIRMED: seller may cancel until `picked_up`; item-level cancellation is seller-only]
out_for_delivery ─→ delivery_failed ─→ out_for_delivery (attempts 2 and 3) | returning_to_seller ─→ returned_to_seller   (Q-33)
```

`orders.status` (stored, updated in the same transaction as its seller orders):
`pending_payment → placed → in_progress → completed | partially_completed | cancelled`
- `completed`: all seller orders are delivered.
- `partially_completed`: at least one delivered and the others are cancelled/returned.
- `cancelled`: none delivered.

**Partial cancellation** [CONFIRMED that it exists; rules: Q-31]: cancelling whole seller orders inside a checkout, and/or cancelling individual item lines/quantities inside a seller order. Every cancellation:
- releases the stock,
- recomputes the subtotal/commission of the affected seller order,
- adjusts the order total,
- for Kashier, flags the difference for manual refund,
- appends to the status history with actor and reason.

### 4.4 Payment
- **COD:** `pending → collected` (agent marks delivered + cash collected). Remittance to the platform is tracked in `finance`.
- **Kashier:** `initiated → paid | failed | expired` (15 min); `paid → partially_refunded_manually | refunded_manually` (admin records the refund after doing it in the Kashier dashboard).
- Kashier webhook: signature verified, deduplicated on the gateway event id, idempotent. The webhook result wins over the client redirect.

### 4.5 Inventory
- Checkout **reserves** stock per variant with an atomic conditional update (no overselling).
- Kashier unpaid after **15 min** → reservation **expired** and released by the worker [CONFIRMED 15 min].
- `delivered` → **committed** (stock decremented for good). `cancelled` → **released**. Returned to seller → released when the seller confirms receipt (Q-33).

### 4.6 Shipment & automatic assignment
One shipment per seller order: **seller pickup address → customer address** [CONFIRMED].
`unassigned → assigned → picked_up → out_for_delivery → delivered | delivery_failed → … → returned_to_seller`.

Auto-assignment [CONFIRMED Q-32]:
- Agents have an availability toggle (`on_shift`) and a home governorate.
- When a seller order becomes `ready_for_pickup`, the shipment is assigned to the **available agent in the pickup governorate with the fewest active shipments**. Ties go to whoever has been idle longest.
- The assignment uses `SELECT … FOR UPDATE SKIP LOCKED` so two shipments never race for the same capacity.
- If no agent is available, the shipment stays `unassigned`, the worker retries every N minutes (config), and an admin can always assign or reassign manually.
- Agents cannot reject an assignment. **Only an admin can reassign** [CONFIRMED Q-41].

### 4.7 Failed delivery [CONFIRMED Q-13, Q-33]
- Each failed attempt records a reason (`customer_unreachable`, `customer_refused`, `wrong_address`, `customer_rescheduled`) and the time.
- `customer_refused` → straight to `returning_to_seller` (no more attempts). Other reasons → re-attempt, up to **3 attempts** in total, and then `returning_to_seller`.
- The agent returns the parcel, and the seller confirms receipt → `returned_to_seller` → stock released.
- Money:
  - COD: nothing collected, no seller credit, no commission.
  - Kashier: the seller order amount is flagged for manual refund.
  - The delivery fee follows the Q-28 rule: charged unless **all** seller orders of the checkout end undelivered.
  - Agents earn no fee share for undelivered shipments.

## 5. Money rules [CONFIRMED]

- EGP `NUMERIC(12,2)`, computed with `decimal.js`, `ROUND_HALF_UP`, rounded at each stored amount.
- `order_items.line_total = unit_price × (quantity − cancelled_quantity)`
- `seller_orders.subtotal = Σ line_total` · `commission = round(subtotal × commission_rate)` · `seller_net = subtotal − commission` [CONFIRMED: subtotal only, rate snapshotted at checkout]
- `orders.delivery_fee` = the fee of the customer's governorate at checkout, charged once [CONFIRMED]. It becomes `0` if all seller orders end undelivered [CONFIRMED Q-28].
- `agent_share = round(delivery_fee × 70%)` [CONFIRMED 70%] · `platform_fee_share = delivery_fee − agent_share`.
- The agent share is divided **equally among the checkout's shipments** [CONFIRMED Q-27]. Any remainder piastre goes to the last delivered shipment. Shipments that are not delivered earn nothing, and **their portion stays with the platform** [CONFIRMED Q-37]. Example: 60 EGP fee, 3 shipments, 1 cancelled → agents 14 + 14, platform 32.
- `orders.total = Σ seller_orders.subtotal + orders.delivery_fee`.
- **Ledger** (when `delivered`):
  - credit the seller `seller_net`;
  - credit the platform `commission`;
  - credit the agent their fee share.
  - For COD, the agent also owes the platform the collected cash, which is cleared when an admin confirms the remittance [CONFIRMED Q-18].
  - Payouts to sellers and to agents (not salaried) [CONFIRMED Q-38] are recorded by an admin after paying outside the system [CONFIRMED Q-11].

## 6. Release 1 API surface (high level) [CONFIRMED]

| Area | Endpoints (all under `/api/v1`) |
|---|---|
| Auth | `POST /auth/register/customer`, `POST /auth/register/seller`, `POST /auth/email/verify`, `POST /auth/email/resend-otp`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/password/forgot`, `POST /auth/password/reset` |
| Customer | `GET/PATCH /me`, CRUD `/me/addresses` |
| Seller | `GET/PATCH /seller/profile`, CRUD `/seller/products`, CRUD `/seller/products/:id/variants`, `PATCH /seller/variants/:id/stock`, `GET /seller/orders`, `POST /seller/orders/:id/accept`, `POST /seller/orders/:id/ready`, `POST /seller/orders/:id/cancel`, `POST /seller/orders/:id/items/:itemId/cancel`, `POST /seller/orders/:id/return-received` |
| Catalog (public) | `GET /categories` (tree), `GET /categories/:id/attributes`, `GET /products` (search + attribute filters + cursor pagination), `GET /products/:idOrSlug` |
| Reference | `GET /governorates` (deliverable ones + fee) |
| Cart | `GET /cart`, `POST /cart/items`, `PATCH/DELETE /cart/items/:id` |
| Checkout & orders | `POST /checkout` (**Idempotency-Key required**), `GET /orders`, `GET /orders/:id`, `POST /orders/:id/seller-orders/:sellerOrderId/cancel` |
| Payments | `POST /orders/:id/payment/kashier-session`, `POST /webhooks/kashier` (signature-verified, no JWT) |
| Delivery agent | `PATCH /agent/availability`, `GET /agent/shipments`, `POST /agent/shipments/:id/picked-up`, `POST /agent/shipments/:id/out-for-delivery`, `POST /agent/shipments/:id/delivered` (+ COD collected), `POST /agent/shipments/:id/failed-attempt` |
| Admin | sellers: list / approve / reject / suspend / commission · CRUD categories + attributes + options · governorate fees · create admins / agents · shipments: assign / reassign · payments: record manual refund · finance: balances, confirm COD remittance, record seller/agent payout |

## 7. Events (outbox → RabbitMQ) [CONFIRMED, v1.1]

The event catalogue (names, publishers, consumers, payloads, queues) is **`02-events.md` v1.0** (approved 2026-10-08, O-3). It replaces the v1.0 list here.
Every envelope carries `eventId`, `eventType`, `version`, `occurredAt`, `correlationId`, `aggregateType`, `aggregateId`, `payload`. Consumers are idempotent on `eventId`.

## 8. Open questions

All overview-level questions are answered. New questions found during system design or the per-module specs go here.

### 8.1 Per-module spec questions (2026-10-08, from specs 01–13): **all answered**

The user accepted every recommendation (2026-10-08). Answers are logged in §9.1. The table is kept for the reasoning.

| # | Topic | Options / recommendation | Spec |
|---|---|---|---|
| S-1 | OTPs and invite tokens would sit in plain text in `events_outbox.payload` (7-day retention) and in RabbitMQ | **(a) Rec:** encrypt the sensitive template variables with AES-256-GCM (key from env), decrypted only by the notifications consumer · (b) accept plain text (OTPs expire in minutes, but an invite token is valid for 72 h) | 02, 03, 13 |
| S-2 | Admin suspend/reactivate user accounts in R1 | **Rec: yes**, minimal (`/admin/users/:id/suspend\|reactivate`) for customers and admins; agents through deactivation (S-10); sellers through seller suspension (doesn't block login) · or defer to R2 | 03 |
| S-3 | COD fee gap in DB-Q1: the fee carrier fails after a sibling was delivered without the fee, and nothing else goes out → the fee is never collected | **(a) Rec:** accept it in R1 (rare); the ledger books only fees actually collected and logs `COD_DELIVERY_FEE_UNCOLLECTED` · (b) change DB-Q1 to "the first shipment *delivered* collects the fee" (amount computed at the door; no gap, but the amount can change between leaving and arriving) | 10, 11, 12 |
| S-4 | Kashier failure webhook (card declined) | **Rec:** record it only; the payment stays `initiated` so the customer can retry within the 15 min window, and expiry cancels · or fail + cancel the order immediately | 10 |
| S-5 | Adding an attribute to a category whose subtree already has products | **Rec: block** (`CATEGORY_HAS_PRODUCTS`), because existing variants would lack the new attribute (SD-7) · or allow it and treat the attribute as optional for old variants | 06 |
| S-6 | Seller stock updates | **Rec:** deltas via `POST /seller/variants/:id/stock-adjustments` (Idempotency-Key), because `on_hand` includes picked-up parcels until `delivered` and an absolute "set" would double-count them · or absolute `PATCH …/stock` (overview §6) | 06 |
| S-7 | Approved seller edits business name / pickup address | **Rec:** no re-approval in R1 (edits apply to new orders only) · or back to `pending_approval` on business-name change | 05 |
| S-8 | Price/stock changed between cart view and checkout | **Rec:** `expectedTotal` required at checkout → `409 ORDER_TOTAL_CHANGED` · or charge the current price silently | 09 |
| S-9 | Admin cancels an order / seller order | **Rec:** not in R1 (full back-office is R2); support asks the seller to cancel · or add `POST /admin/seller-orders/:id/cancel` now | 09 |
| S-10 | Deactivated delivery agent | **Rec:** also suspend the login (identity) · or keep login with read-only access | 11 |
| S-11 | What a seller sees of the customer | **Rec:** no name, phone or address, only the drop-off governorate (the agent handles the customer) · or show the recipient name | 09 |
| S-12 | COD payment when nothing is collected (all seller orders cancelled/returned) | **Rec:** new COD status `cancelled` (schema change D-1) · or leave it `pending` forever | 10 |
| S-13 | Agent-share remainder piastres ("go to the last delivered shipment", overview §5) when the last seller order to finish isn't delivered | **Rec:** the remainder goes to the delivery that closes the order; if the closing event is a return/cancel, the remainder stays with the platform · or give it to the earliest delivered shipment | 09 |
| S-14 | Seller/agent see their own balances and statements | **Rec: yes** (`/seller/finance/*`, `/agent/finance/*`, read-only) · or admin-only in R1 | 12 |
| S-15 | Email templates | **Rec:** in the repo (versioned, tested) · or Mailjet-hosted template ids from env (editable by non-developers) | 13 |
| S-16 | Auth parameters (env values) | **Rec:** OTP 10 min, 5 attempts, 60 s resend cooldown · invite 72 h · access token 15 min · refresh token 30 days | 03 |
| S-17 | Sellers pending approval preparing drafts | **Rec:** all product writes need `approved` · or allow drafts while `pending_approval` (no activation) | 06 |
| S-18 | Reassign a shipment after pickup | **Rec:** not in R1 (the parcel is physically with the agent) · or allow admin reassignment at any active status | 11 |
| S-19 | Change password while logged in | **Rec: add** `POST /auth/password/change` (`currentPassword`, `newPassword`; revokes other sessions) · or users go through forgot-password | 03 |

### 8.2 Proposed changes to approved documents

| # | Document | Change | Reason | Status |
|---|---|---|---|---|
| O-1 | `00-overview.md` §2 | Table names: `otp_codes` → `verification_codes`; finance `seller_payouts` → `finance_accounts`, `ledger_entries`, `cod_remittances`, `payouts`; add the history/settings tables listed in `02-database.md` §1 | Align with the approved schema | **Pending** |
| O-2 | `00-overview.md` §6 | API surface: replace with specs 03–12 (new: invite accept, password change, admin admins, resend invite, user suspend/reactivate, seller reapply, settings endpoints, `DELETE /cart`, agent profile, finance self-service, stock adjustments) | Detailed specs | **Pending** (with the module specs) |
| O-3 | `00-overview.md` §7 | Event list: replace with `02-events.md` | Detailed specs | **Applied** (v1.1), implied by approving `02-events.md` |
| A-1 | `01-architecture.md` §3, §5 | Event names and queue bindings as in `02-events.md` | E-1…E-7 | **Applied** (v1.1), implied by approving `02-events.md` |
| A-2 | `01-architecture.md` §2 | Dependency edges: `customers → identity`, `sellers → identity` (self-registration routes live in the profile modules, so identity depends on nobody); `cart → sellers` (display names); `finance → sellers, delivery` (profile resolution, display names) | Still acyclic | **Applied** (architecture v1.3, approved 2026-10-09) |
| A-3 | `01-architecture.md` §7.1 | Checkout inserts the order rows **before** `inventory.reserve` (a reservation references `order_item_id`); same transaction, so a shortfall still rolls everything back | Schema FK | **Pending** |
| D-1 | `02-database.md` §9 | `payments.status`: add `cancelled` (COD) | S-12 | **Applied** (v1.1), implied by accepting S-12 |
| D-2 | `02-database.md` §10 | `shipments`: add `payment_method VARCHAR(20)` (CHECK), `order_number VARCHAR(20)`, `order_delivery_fee money`, `pickup_business_name VARCHAR(150)`; drop `agent_fee_share` (ordering computes it, and the ledger records it) | Fee carrier + agent screen need them, and delivery can't call ordering | **Pending** |
| D-3 | `02-database.md` §10 | Add `idx_shipments_status_created_at_id (status, created_at DESC, id DESC)` | `GET /admin/shipments` | **Pending** |
| D-4 | `02-database.md` §2 | Add `idx_refresh_tokens_expires_at (expires_at)` for the retention cleanup (`DELETE … WHERE expires_at < now() - retention`); every refresh inserts a row, so the table is large. Also: `fk_refresh_tokens_replaced_by_id` is `ON DELETE SET NULL` (audit pointer; lets the cleanup delete rows in any order) | Found while writing the P1 identity migrations | **Applied** (v1.2, approved 2026-10-08) |
| D-5 | `02-database.md` §5 | Public listing indexes on `published_at` instead of `created_at` | "Newest" means newly published (P3-Q7) | **Applied** (v1.5, approved 2026-10-10) |
| D-6 | `02-database.md` §6 | Stock-history index gains the `id` tie-break | Keyset pagination (P3-Q8) | **Applied** (v1.5, approved 2026-10-10) |
| D-7 | `02-database.md` §5 | Add `idx_products_category_id (category_id)` | Category usage checks outside VIS (CLAUDE.md §6.3) | **Applied** (v1.6, approved 2026-10-10) |

## 9. Answered log (2026-10-07)

| Q | Answer |
|---|---|
| Q-1 | Price per variant |
| Q-2 | Admin defines attributes per category |
| Q-3 | Categories are a tree |
| Q-4 | Soft delete |
| Q-4b | Product images in R2 |
| Q-4c | No admin approval for products; the seller publishes |
| Q-5 | Seller onboarding: business name only (for now) |
| Q-6 | Rate change applies to new orders only; commission on item subtotal only |
| Q-7 | Seller must accept; auto-cancel deadline |
| Q-8 | Order status stored |
| Q-9 | One Kashier payment per checkout |
| Q-10 | Customer cancels before seller accepts; seller can cancel; partial cancellation exists |
| Q-11 | R1: admin pays sellers outside the system |
| Q-12 | Kashier stock hold 15 min |
| Q-12b | Automatic agent assignment |
| Q-13 | Max 3 delivery attempts (rest proposed in §4.7) |
| Q-14 | Email only for now |
| Q-15 | Fee per governorate; platform + agent keep it |
| Q-16 | Keep coverage simple |
| Q-17 | Direct pickup from each seller, no hub |
| Q-18 | Agent hands over COD cash; admin confirms receipt |
| Q-19 | No invoices / VAT in R1 |
| Q-20 | Admins seeded, then admins create admins; agents created by admin |
| Q-21 | Email verification required; login by email |
| Q-22 | Acceptance deadline 24 h |
| Q-22b | Wall-clock time |
| Q-23 | Fixed % split |
| Q-23b | Agent 70% |
| Q-24 | Fee once per checkout |
| Q-25 | Holding period in R2; R1 credits on `delivered` |
| Q-26 | Only governorates with a fee are deliverable |
| Q-27 | Agent share split equally among shipments |
| Q-28 | Partial cancel: full fee; all cancelled: no fee / refunded |
| Q-13/Q-33 | Failed-delivery flow in §4.7 approved |
| Q-29 | Business name + pickup address (governorate) + phone required at registration; rejected sellers can re-apply |
| Q-30 | Tree max depth 3; products may attach to any level; attributes inherited by descendants |
| Q-31 | Item-level cancel is seller-only; seller cancels until `picked_up`; customer cancels whole seller orders only while `placed` |
| Q-32 | Auto-assignment algorithm in §4.6 approved |
| Q-34 | 70/30 split is one global setting |
| Q-35 | Email provider: Mailjet |
| Q-36 | Suspended seller's open orders continue |
| Q-38 | Agents are not salaried; their fee shares are paid out by admin outside the system |
| Q-39 | Admin-created accounts get an email invite |
| Q-40 | Sellers must verify email before approval |
| Q-37 | Undelivered shipment's agent-share portion stays with the platform |
| Q-41 | Agents cannot reject assignments; only admins reassign |
| Q-42 | No product images in R1 (confirmed, R2) |

### 9.1 Answered log: per-module spec questions (2026-10-08)

The user accepted every recommendation in §8.1.

| Q | Answer |
|---|---|
| S-1 | Secret email variables (OTP, invite URL) are AES-256-GCM encrypted in the outbox/broker (`02-events.md` §3.1) |
| S-2 | Admin suspend/reactivate user accounts in R1 (customers, admins); agents via deactivation; sellers via seller suspension |
| S-3 | COD fee gap accepted in R1: only fees actually collected are booked; `COD_DELIVERY_FEE_UNCOLLECTED` logged |
| S-4 | Kashier failure webhooks are recorded only; the payment stays `initiated` until success or expiry |
| S-5 | Adding an attribute to a category whose subtree has products is blocked |
| S-6 | Stock changes are deltas via `POST /seller/variants/:id/stock-adjustments` (Idempotency-Key) |
| S-7 | No re-approval after an approved seller edits the profile |
| S-8 | `expectedTotal` required at checkout (`409 ORDER_TOTAL_CHANGED`) |
| S-9 | No admin order cancellation in R1 |
| S-10 | Deactivating an agent also suspends their login |
| S-11 | Sellers see no customer PII, only the drop-off governorate |
| S-12 | New COD payment status `cancelled` (D-1) |
| S-13 | Agent-share remainder goes to the delivery that closes the order, else stays with the platform |
| S-14 | Seller/agent read-only finance self-service endpoints in R1 |
| S-15 | Email templates live in the repo |
| S-16 | OTP 10 min, 5 attempts, 60 s resend cooldown · invite 72 h · access token 15 min · refresh token 30 days (env values) |
| S-17 | All product writes require an `approved` seller |
| S-18 | No shipment reassignment after pickup in R1 |
| S-19 | Add `POST /auth/password/change` (revokes other sessions) |
