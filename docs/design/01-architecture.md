# System Design 01 — Architecture (Release 1)

Status: **v1.10 APPROVED (2026-10-13).** v1.1: event names and queue bindings now follow `docs/spec/02-events.md` v1.0 (A-1). v1.2: consumers with external effects run them before the dedupe transaction (§3.2, Phase 1). v1.3: dependency edges for customers, sellers, cart and finance (§2, A-2); governorates cache TTL (§8, Phase 2). v1.4: catalog cache keys and TTLs (§8), "newest" sorts on `published_at` (§9) (Phase 3). v1.5: typo search matches words (§9, P3-O1). v1.6: edge `cart → customers` (§2, A-4, Phase 4). v1.7: checkout inserts the order rows before reserving stock (§7.1, A-3); one lock order across ordering, inventory and payments (§3.1); order jobs handle one order per transaction (§6); Kashier sessions and webhook signature (§7.2) (Phase 5). v1.8: the expiry job abandons no session (§6, spec 10 PA-11). v1.9: region `eu-central-1` (SD-3d), sizes, RabbitMQ 4.2, TLS to the data stores, secrets, network and egress IPs (K-7), deploy pipeline, alerting (§12.1, §13, Phase 8). v1.10: suspended-user deny entry in Redis (§8, §10, spec 03 I-11). Changes from now on need explicit approval and a version bump.
**v2.3 APPROVED (2026-10-20):** §14.4 per-queue prefetch on the consumer host; `HTTP_STATUS.ACCEPTED` (R2-P1). **v2.2 APPROVED (2026-10-20):** §14.9 local / test MinIO image is the community build `pgsty/minio` (upstream MinIO no longer publishes images; R2-P1). **v2.1 APPROVED (2026-10-20):** §14.2 audit row per spec 20 BO-9 (R2-P1). **v2.0 APPROVED (2026-10-20):** §14 adds Release 2 (realtime process, media storage and CDN, new modules and edges, lock order, jobs, security, capacity, hosting, new dependencies). Kept as its own section, so every cross-reference stays valid (R2-Q1). §14.11 A-5…A-10 answered 2026-10-20 (every recommendation accepted).
Inputs: `CLAUDE.md` (engineering rules), `docs/spec/00-overview.md` v1.0 (business). Schema: `02-database.md`.

---

## 1. Runtime topology

```
                 Mobile app
                     │ HTTPS
              ┌──────▼───────┐
              │ TLS / LB /   │   (TLS terminates here, §13)
              │ reverse proxy│
              └──────┬───────┘
          ┌──────────┴──────────┐
     ┌────▼────┐           ┌────▼────┐
     │  api #1 │    ...    │  api #N │     stateless, same image, `node dist/server.js`
     └────┬────┘           └────┬────┘
          │  Postgres / Redis   │
  ┌───────┼─────────────────────┼─────────────┐
  │  ┌────▼─────┐  ┌───────┐  ┌─▼──────────┐  │
  │  │Postgres18│  │ Redis │  │ RabbitMQ   │  │
  │  └────▲─────┘  └───▲───┘  └─▲────────┬─┘  │
  └───────┼────────────┼────────┼────────┼────┘
     ┌────┴────────────┴────────┴──┐     │ consume
     │ worker #1..M                │◄────┘
     │  outbox drain · consumers   │  same image, `node dist/worker.js`
     │  · scheduled jobs           │
     └─────────────────────────────┘
          Kashier (payments) ⇄ api (webhook)    Mailjet ◄ worker (emails)
```

| Process | Responsibility | Scaling |
|---|---|---|
| `api` | HTTP only: validate, authorize, run use cases, write DB + outbox in one transaction | Horizontal. 2 replicas cover the 300 req/s peak, and 3 give headroom |
| `worker` | Outbox drain → RabbitMQ, event consumers, scheduled jobs | Horizontal-safe: jobs are guarded by Postgres advisory locks, and consumers compete on queues. Start with 1–2 |
| Postgres 18 | Single primary, the source of truth | Vertical first. A read replica is optional later for catalog reads |
| Redis | Rate limits, idempotency keys, cache. **Not a source of truth** | Single instance. Losing it must never lose business data |
| RabbitMQ | Async event delivery between modules | Single node in R1 (hosting: §13) |

The API never calls Mailjet or RabbitMQ inside a request: email and events go through the outbox. The API calls **Kashier** only to create a payment session, never inside a DB transaction.

## 2. Module dependency graph (synchronous calls)

Synchronous calls go through a module's public API (`index.ts`, resolved by DI token). **Arrows are allowed directions. The graph must stay acyclic** (enforced with an ESLint boundaries rule).

```
                        identity
           ┌───────────────┼──────────────────┐
       customers        sellers           delivery ──► (governorates, agents, shipments)
           ▲               ▲                  ▲
           │      catalog ─┘                  │
           │        ▲  │                      │
           │        │  └──► inventory         │
           │      cart ─► inventory, customers│
           │        ▲                         │
           └─── ordering ──► catalog, sellers, customers, inventory, payments, delivery(fee lookup only)

     payments ──► (none)          finance ──► sellers, delivery          notifications ──► (none: the recipient email is in the event payload)
```

The full edge list (A-2, v1.3; A-4, v1.6), which `module-graph.js` enforces:

| Module | May call |
|---|---|
| customers | identity |
| sellers | identity |
| delivery | identity |
| catalog | sellers, inventory |
| cart | customers (profile from the JWT `sub`, A-4), catalog, inventory, sellers (display names) |
| ordering | customers, cart, catalog, sellers, inventory, payments, delivery |
| finance | sellers, delivery (profile resolution, display names) |
| identity, inventory, payments, notifications | none |

The rules:
- `ordering` is the orchestrator of checkout and may call the others. Nobody calls `ordering` synchronously.
- `payments`, `delivery`, `finance` and `notifications` **react to events** and never call `ordering`. This is what breaks the would-be cycles (ordering → payments → ordering, ordering → delivery → ordering).
- **Event contracts** (names + payload types + version) live in the shared kernel `src/lib/events/contracts/`, not inside modules, so a consumer never imports the publisher module.

## 3. Interaction patterns per use case

| Use case | Pattern | Why |
|---|---|---|
| Checkout | **One DB transaction across modules**: ordering calls cart / catalog / sellers / customers / delivery / inventory / payments public APIs, passing the same `trx` | Stock reservation, order creation, payment record and cart clearing must be atomic. Same DB, so no saga is needed (SD-9) |
| Kashier paid / failed | Webhook → `payments` updates the payment + outbox `payment.paid` → `ordering` consumer moves seller orders `pending_payment → placed` | Payments stays independent of ordering |
| Seller accepts / ready | ordering (sync) → outbox `seller_order.ready_for_pickup` → `delivery` consumer creates the shipment + auto-assigns | Delivery owns shipments. The event payload carries the pickup/drop-off snapshot |
| Agent picked up / delivered / failed | delivery (sync) → outbox `shipment.*` → `ordering` consumer updates the seller order (+ `inventory.commit` in its transaction) → outbox `seller_order.delivered` → `finance` consumer writes ledger entries | Each module changes only its own tables |
| Cancellation | ordering (sync, in one trx with `inventory.release`) → outbox `seller_order.cancelled` → payments (refund due for Kashier, COD amount) / delivery (cancel shipment if one exists) consumers. Finance books nothing before delivery (E-6) | |
| Seller approved / suspended | sellers → outbox → `catalog` consumer flips `products.seller_active` | Keeps public listings join-free across modules |
| Stock level change | inventory → outbox `inventory.stock_status_changed` → `catalog` consumer updates `products.in_stock` | Same as above. Listings are eventually consistent (≤ seconds), while checkout always checks real stock |
| Emails (OTP, invites) | identity → outbox `notification.email_requested` → `notifications` consumer → Mailjet | Retries are handled by the broker. Requests never wait on Mailjet |

### 3.1 Transactions across modules
- One `lib/db` `TransactionRunner.run(async trx => …)` starts the transaction. Every public module method that writes accepts `trx` and passes it to its repositories.
- Outbox inserts use the same `trx`, so the state change and its event commit or roll back together.
- Lock ordering, to avoid deadlocks: `carts` (checkout only) → `orders` → `seller_orders` (by id) → `inventory_items` (by id) → `payments`. Inventory rows are locked/updated **sorted by `inventory_item.id`**. The Kashier webhook never locks `orders`, and ordering's payment consumer never locks `payments` [v1.7, spec 09 OR-3].

### 3.2 Consistency guards for consumers
- At-least-once delivery. Every consumer records `(consumer, event_id)` in `processed_events` **in the same transaction** as its effects, and a duplicate is acknowledged and skipped.
- **External effects** (an HTTP call such as sending an email) must not run inside that transaction (CLAUDE.md §6.4). A consumer with one declares a `beforeTransaction` step: the host checks `processed_events` first and skips duplicates, runs the step outside any transaction, then commits its result (e.g. the `notification_log` row) together with the `processed_events` row. A crash between the two can repeat the effect once on redelivery, so this is only used where that is acceptable (spec 13 UC-NO-1) [v1.2].
- Consumers are **state-machine guarded**: they apply a transition only if the current state allows it (e.g. ignore `shipment.picked_up` if the seller order is already `cancelled`, and log at `warn`). Out-of-order or stale events are therefore harmless.

## 4. Request pipeline (api)

Order of middleware:
1. `trust proxy` (from env) → `helmet` → `x-powered-by` off.
2. **Correlation ID** (AsyncLocalStorage).
3. Request-completion logger.
4. CORS (allow-list; mostly irrelevant for mobile).
5. **Raw body for `/api/v1/webhooks/kashier`** (needed for signature verification), then `express.json({ limit })` for everything else.
6. Global rate limit (Redis).
7. Routes. Per route:
   - auth guard (Bearer JWT) → role guard
   - strict rate limit where sensitive
   - `Idempotency-Key` where required
   - DTO validation → controller
8. 404 handler → global error handler.

Health: `GET /health/live`, `GET /health/ready` (Postgres, Redis, RabbitMQ with timeouts). Neither needs auth. Rate limiting is skipped for them.

## 5. Messaging (RabbitMQ)

- **Exchange:** `nile.events` (topic, durable). Routing key = event type (e.g. `seller_order.delivered`).
- **Queues:** one per consumer **purpose**, named `<module>.<purpose>`, durable, bound to specific keys. The full list of queues and bindings is in **`docs/spec/02-events.md` §2** (the source of truth, A-1).
- **Retries:** a failed message is re-published to a per-queue retry queue with TTL backoff (e.g. 5 s → 30 s → 5 min, from config), then sent to the per-queue **DLQ** `<queue>.dlq` after N attempts. A message landing in a DLQ produces an `error` log with event code `MQ_DEAD_LETTERED` [SD-4].
- **Prefetch** from config. Manual ack after the DB transaction commits.
- **Envelope:** `eventId` (= outbox row id, UUID v7), `eventType`, `version`, `occurredAt`, `correlationId`, `aggregateType`, `aggregateId`, `payload`. Consumers restore `correlationId` into the AsyncLocalStorage context, so logs trace end-to-end.
- **Outbox drain:** batches using `FOR UPDATE SKIP LOCKED`, publisher confirms, mark dispatched. On failure: increment attempts, record `last_error`, set `next_attempt_at` with backoff. Order is preserved per aggregate as far as possible, and consumers don't rely on it (§3.2).

## 6. Scheduled jobs (worker)

Every job runs under `pg_try_advisory_lock(<job key>)`, so only one worker instance runs it at a time. Intervals come from env. Each run logs the job name, the number of rows affected and `durationMs`.

| Job | Every | What it does |
|---|---|---|
| `outbox-drain` | 1 s | Publish pending outbox rows |
| `kashier-payment-expiry` | 30 s | `pending_payment` orders past `payment_expires_at` → seller orders `cancelled`, reservations released, payment `expired`, one short trx **per order** (`FOR UPDATE SKIP LOCKED` on the order row, batch size from env). Before expiring, outside the trx, it skips payments already `paid` locally, asks Kashier for the session status so it doesn't race a late success (SD-5), and leaves a payment in flight for the next run. Kashier itself stops taking payment at the session's `expireAt` [v1.8, spec 09 §3.10, spec 10 PA-11, PA-13] |
| `seller-acceptance-timeout` | 1 min | `placed` seller orders with `accept_deadline_at < now()` → `cancelled` (reason `seller_acceptance_timeout`), one short trx per order as above [v1.7] |
| `shipment-assignment-retry` | 1 min | Retry auto-assignment for `unassigned` shipments |
| `outbox-cleanup` | daily | Delete dispatched outbox rows older than the retention period (env) |
| `processed-events-cleanup` | daily | Delete dedupe rows older than the retention period |
| `expired-codes-cleanup` | daily | Delete expired/consumed OTPs and invite tokens, and revoked/expired refresh tokens older than the retention period |

## 7. Key flows

### 7.1 Checkout (`POST /api/v1/checkout`, Idempotency-Key required) [v1.7, A-3; detail in spec 09 §3.1]
1. Validate the DTO (`addressId`, `paymentMethod`, `expectedTotal`).
2. Before the transaction (reads): the address snapshot (customers API), the governorate fee (delivery API; reject if not deliverable) and the agent fee-share rate.
3. **One transaction:**
   - Load and lock the cart (cart API). Empty → `CART_EMPTY`.
   - Batch-load the variants with their product/seller data (catalog API, one query) and the seller status/commission/pickup snapshot (sellers API, one query). Reject if any variant isn't purchasable or any seller isn't approved.
   - Compute the money with `decimal.js` (overview §5); reject if it differs from `expectedTotal`.
   - Insert `orders`, `seller_orders`, `order_items` and the status history (multi-row inserts). The rows come **before** the reservation, because a reservation references `order_item_id`.
   - `inventory.reserve(lines, trx)`: an atomic conditional update per item, sorted by id. Any shortfall → `409 INSUFFICIENT_STOCK` with the affected variant ids, and the whole transaction (order rows included) rolls back.
   - `payments.createForOrder(trx)` (COD → `pending`, Kashier → `initiated`).
   - `cart.clear(trx)`.
   - Outbox `order.placed` (COD only; for Kashier, `placed` happens on payment).
   - Commit.
4. The response includes the order. For Kashier, it also includes the Kashier session URL (session created **after** commit, one per payment; SD-5 covers the failure case).

### 7.2 Kashier webhook (`POST /api/v1/webhooks/kashier`)
- Parse the **raw body** and verify `x-kashier-signature` (an HMAC over the signed fields Kashier lists, keyed by the payment API key from env) [v1.7, spec 10 PA-1]. Invalid → `401`, logged at `warn` (no payload in logs), nothing stored.
- Insert `payment_events` with `uq(provider, provider_event_id)`. A duplicate → `200` with no further work.
- Check the amount and the order reference against the payment. On a mismatch: `error` log, payment `failed`, and an admin review flag.
- Transition the payment, plus the outbox `payment.paid` / `payment.failed` event, then respond `200` quickly.

### 7.3 Auto-assignment (delivery consumer of `seller_order.ready_for_pickup`)
- One trx: create the shipment (idempotent on `seller_order_id`).
- Select a candidate agent: `status='active' AND on_shift AND home_governorate_id = pickup governorate`, ordered by active shipment count and then `last_assigned_at`, `FOR UPDATE SKIP LOCKED LIMIT 1`.
- Assign, set `last_assigned_at`, and write the outbox `shipment.assigned`.
- No candidate → stays `unassigned`, and the retry job picks it up.

## 8. Caching (Redis)

| Data | Strategy | Invalidation |
|---|---|---|
| Category tree + attributes | Cache-aside, key `v1:catalog:category-tree`, TTL `CATEGORY_TREE_CACHE_TTL_SECONDS` [v1.4] | Deleted on any admin category/attribute change (same request, after commit) |
| Governorates + fees | Cache-aside, TTL `GOVERNORATES_CACHE_TTL_SECONDS` [v1.3] | Deleted on fee change (after commit) |
| Product detail (public) | Cache-aside, key `v1:catalog:product:<id>` (static part only: no visibility, prices or stock, which are read fresh), TTL `PRODUCT_DETAIL_CACHE_TTL_SECONDS` [v1.4] | Deleted after commit on product/variant change. Stock is **not** taken from cache at checkout |
| Product lists / search | **Not cached in R1.** Indexed queries are enough at the target load | n/a |
| Suspended users (not a cache: a deny list) | Key `auth:suspended:<userId>`, written after a suspension commits, TTL = access-token lifetime [v1.10, spec 03 I-11] | Deleted on reactivation; expires once every token issued before the suspension has expired |

- Cache keys use constants with a version prefix (`v1:catalog:category-tree`).
- Redis failures degrade to reading from the DB, logged at `warn`. They never fail the request.
- Rate limiting and idempotency **fail closed** on sensitive routes (auth, checkout) and fail open elsewhere (config).

## 9. Search & filtering (catalog)

- Postgres FTS: a `products.search_vector` generated column (name weight A, description weight B) + GIN index. A `pg_trgm` GIN index on name handles typos and partial words, matched per word (`q <% name`, threshold from env) [v1.5, spec 06 CA-14]. Text search configuration: `english` [SD-1].
- Filters, from a whitelist:
  - `category` (includes descendants: the ids come from the cached tree, then `category_id = ANY(?)`)
  - `price[gte|lte]` (on the denormalized `min_price`)
  - `inStock`
  - `seller`
  - `attr[<code>]=<optionCode,...>`: `EXISTS` subqueries through `variant_attribute_values`
- Sort: `newest` (`published_at, id`) [v1.4], `price_asc/desc` (`min_price, id`), `relevance` (search only). All use cursor pagination.

## 10. Security specifics

- JWT: **RS256** [SD-11]. The private key (PEM, from a secret env var) exists only in `api`; the public key is used for verification. Tokens carry a `kid` header so keys can be rotated (the old public key stays valid until its tokens expire). The access token TTL comes from env. Refresh tokens are opaque random 256-bit strings, stored as SHA-256 hashes, rotated on every use, and reuse revokes the family.
- A suspension blocks the user's access tokens at once: `authenticate` checks the Redis deny entry (§8) and answers `401`; it fails open if Redis is down, since the tokens expire within their TTL anyway [v1.10, spec 03 I-11].
- Role guards + **ownership checks in services**:
  - a seller only touches products/orders where `seller_id` = theirs;
  - an agent only touches shipments where `agent_id` = theirs;
  - a customer only touches their own addresses/orders/cart.
- Rate limits (env-configured), keyed by IP + email:
  - `login`, `register`, `email/verify`, `resend-otp`, `password/forgot`, `password/reset`, `refresh`
  - `checkout` (per user)
- OTPs: 6 digits, stored hashed, expiry from env, max attempts from env, single use, and a new OTP invalidates older ones. Invite links: random 256-bit token, stored hashed, single use, expiry from env.
- Kashier webhook: signature + amount verification. Its own rate limit is skipped, while body size is limited.
- PII in logs: emails and phones are masked by the logger's redaction rules.

## 11. Capacity check against the targets (spec §15 / CLAUDE.md)

| Concern | Estimate | Verdict |
|---|---|---|
| Checkout writes | 20k orders/day peak ≈ 0.25/s average. A 10× burst is ~2.5/s, each ~15 short statements | Trivial for one Postgres primary |
| Read traffic | 300 req/s peak, ~95% catalog reads, served by indexed queries + Redis for hot reference data | 2–3 api replicas |
| DB connections | api pool ~10 × 3 + worker ~5 × 2 ≈ 40 | Under Postgres's default of 100. PgBouncer is not needed in R1 |
| Hot rows | Flash-sale variants: conditional `UPDATE … WHERE on_hand - reserved >= qty` serializes on the row; the lock is held only briefly | OK. Checkout transactions stay short (no network calls) |
| Data growth / year | ~2M orders, ~5M order items, ~10M ledger/history rows | No partitioning in R1. Append-only tables (ledger, histories) are keyed by UUID v7 + `created_at`, ready for monthly partitioning later |
| Outbox | ~10 events per order ≈ 200k/day peak | Partial index on pending rows + daily cleanup |

## 12. Design decisions log & open questions

### 12.1 Decided (2026-10-07)

| # | Decision |
|---|---|
| SD-1 | All content (categories, attributes, products, emails) is in **English** only. FTS uses the `english` text search configuration. Single `name` columns |
| SD-2 | COD: one fee per checkout, collected **once**. It is attached to the **first shipment of the checkout that goes `out_for_delivery`** (so the agent knows the exact amount before handing over the parcel). If that shipment fails or returns, the fee moves to the next shipment going out. Approved as DB-Q1 |
| SD-3 | Managed services + containers, on **AWS** (§13). Infrastructure, staging and prod as in §13 |
| SD-3b | No data-residency requirement |
| SD-3c | Infrastructure as code with **Terraform** |
| SD-4 | **No** metrics endpoint or error-tracking service in R1. Operational signals (DLQ messages, job failures, 5xx) are emitted as structured `error` logs with stable `event` codes, so alerting can be added later on top of the logs |
| SD-5 | Late Kashier success after expiry → payment `paid`, order stays `cancelled`, full manual refund flagged. A failed session creation is retried by the app until expiry |
| SD-6 | Seller business names are **unique, case-insensitive** |
| SD-7 | Attributes are option lists, and all of them define variants. A product in a category with no attributes has one default variant |
| SD-8 | Composite PKs allowed for pure join/dedupe tables |
| SD-9 | Checkout = one DB transaction across modules |
| SD-10 | Human-readable `order_number` (`NM-` + sequence) |
| SD-11 | JWT signed with **RS256** (key pair) |
| SD-3d | Region **`eu-central-1`** (Frankfurt): no residency requirement, ~50–60 ms from Cairo, every service we need. RDS PostgreSQL 18 and Amazon MQ RabbitMQ 4.2 are checked there with the AWS CLI before the first apply; `me-central-1` (UAE) is the fallback if a check fails (P8-Q2, 2026-10-13) |
| A-5…A-10 | Release 2 (2026-10-20, §14.11): the web app is hosted outside this repository by the web team · images processed in the worker (`media.processing` prefetch 1, prod worker 1 vCPU / 2 GB) · the existing ALB serves `/realtime*`, idle timeout 120 s · CDN on `media.<domain>` (ACM in `us-east-1`) · the §14.10 dependencies approved · MinIO through Testcontainers in integration tests, an in-memory storage fake in unit tests |
| SD-12 | Phase 8 (P8-Q3…Q15, 2026-10-13): staging and prod written over the same Terraform modules in Phase 8 (no AWS needed), **staging applied in Phase 9** (staging deploy), prod at a separate go-live; two AWS accounts in one Organization; the sizes, broker version, TLS, secrets, network, pipeline and alerting in §13 |

### 12.2 Open

None. SD-3d was settled in Phase 8 (§12.1).

## 13. Hosting [CONFIRMED SD-3: AWS]

Principle: **managed stateful services, containers for our code.** Our team then runs only stateless containers, and backups, failover and patching of Postgres/Redis/RabbitMQ are the provider's job. A single VM can't reliably reach the 99.9% target: one host failure or OS patch means downtime, and backups/restore become our responsibility.

| Component | Production | Staging | Dev (local) |
|---|---|---|---|
| api | Managed container service, **2+ replicas** across 2 availability zones, autoscaling on CPU | 1 replica | docker compose |
| worker | Same service, **2 replicas** (safe thanks to advisory locks) | 1 replica | docker compose |
| Postgres 18 | **Managed**, Multi-AZ standby, automated backups + point-in-time recovery (≥7 days), encryption at rest | Managed, single-AZ, smallest size | `postgres:18` container |
| Redis | Managed, single node (it's not a source of truth) | Managed, smallest | `redis` container |
| RabbitMQ | Managed broker (single node in R1) | Managed, smallest | `rabbitmq:management` container |
| TLS / LB | Managed load balancer with a managed certificate. TLS terminates there, and traffic to the api stays in the private network | Same | none (plain HTTP on localhost) |
| Secrets | Provider secret manager → injected as env vars (JWT keys, DB/Redis/RabbitMQ creds, Kashier & Mailjet keys) | Same, separate secrets | `.env` (never committed) |
| Images | **ECR**, tagged with the git SHA [v1.9, P8-Q12] | Same image as prod | Built locally |
| Deploy | GitHub Actions: CI green on `main` → build & push image → run migrations as a one-off task → rolling deploy to staging → **manual approval** → prod | | |
| Networking | DB / Redis / RabbitMQ in private subnets only, reachable only from the api/worker security group | Same | |

**Chosen provider [SD-3: the user delegated the choice; Claude recommends AWS]:** **AWS**
- **Why:** it is the most mature option for every managed piece we need, including RDS PostgreSQL 18 Multi-AZ with point-in-time recovery, Amazon MQ for RabbitMQ, and ElastiCache. It has regions close to Egypt (Middle East / Southern Europe). ECS Fargate needs no cluster management, and GitHub Actions integrates natively via OIDC (no long-lived AWS keys in CI).
- **Services:**
  - ECS Fargate (api service + worker service)
  - ALB + ACM certificate
  - RDS PostgreSQL 18 Multi-AZ
  - ElastiCache (Redis OSS)
  - Amazon MQ (RabbitMQ)
  - Secrets Manager
  - ECR (images)
  - CloudWatch Logs (stdout JSON logs; log-based alerting can be added later, SD-4)
- **Infrastructure as code: Terraform** [SD-3c] in `infra/terraform/`, with one root module per environment (`envs/staging`, `envs/prod`) over shared modules (network, ecs-service, rds, elasticache, amazon-mq, alb, secrets). State lives in S3 with locking. `terraform plan` runs in CI on PRs touching `infra/`, and `apply` is manual-approval only.
- Availability of every service (especially RDS PG 18 and Amazon MQ RabbitMQ) must be verified **in the chosen region** before provisioning.

Other options considered:

- **GCP:** Cloud Run (always-on CPU for the worker) + Cloud SQL Postgres 18 HA + Memorystore + CloudAMQP + Secret Manager.
- **DigitalOcean** (simplest and cheapest): App Platform + Managed PostgreSQL (with standby node) + Managed Redis-compatible store + CloudAMQP.

Migrations run **before** the new version takes traffic, as a separate one-off container (`npm run migrate`). Because of the expand/contract rule (CLAUDE.md §6.1), the old version keeps working during a rolling deploy.

Region: **`eu-central-1`** (SD-3d).

### 13.1 Phase 8 specifics [v1.9, P8-Q3…Q15]

| Concern | Decision |
|---|---|
| Environments and accounts | Two AWS accounts in one Organization (staging, prod). `envs/staging` and `envs/prod` use the same modules, written in Phase 8; staging is applied in Phase 9, prod at a separate go-live step with its own approval |
| Terraform | Exact versions of Terraform (≥ 1.10) and the AWS provider pinned, lock file committed. S3 state per env with **native S3 locking** (`use_lockfile`; DynamoDB locking is deprecated), bucket versioned, encrypted, public access blocked. A `bootstrap` root applied once by hand: state bucket, GitHub OIDC provider, a read-only `plan` role and a `deploy` role scoped to this repository. Our own modules (`network`, `alb`, `ecs-service`, `rds`, `elasticache`, `amazon-mq`, `secrets`, `ecr`, `alarms`); no community modules |
| Network | One VPC per env over 2 AZs. Public subnets hold only the ALB and the NAT gateway(s); ECS tasks, RDS, ElastiCache and Amazon MQ sit in private subnets, reachable only from the app security group. Staging 1 NAT gateway, prod 1 per AZ; S3 gateway endpoint. Outbound traffic leaves through the NAT Elastic IPs, which are **allow-listed in Kashier** (K-7, spec 10 PA-17) |
| Postgres | RDS PostgreSQL 18, gp3, encrypted, `rds.force_ssl = 1`, automated backups with PITR (staging 7 days, prod 14), deletion protection in prod. Staging `db.t4g.small` single-AZ; prod `db.m7g.large` Multi-AZ instance |
| Redis | ElastiCache **Redis OSS 7.x** (the engine local dev and tests use), TLS in transit and an AUTH token. Staging `cache.t4g.micro`; prod `cache.t4g.small` |
| RabbitMQ | Amazon MQ **RabbitMQ 4.2**, single instance, `mq.m7g.medium` in both envs. Our durable classic queues with TTL dead-letter retries work unchanged on 4.2 (only classic mirroring is gone). Local docker-compose and the Testcontainers image move to `rabbitmq:4.2-management` so tests run on the same major |
| Containers | ECS Fargate, **x86_64** (bcrypt is native; CI builds amd64). api 0.5 vCPU / 1 GB: staging 1 task, prod 2–4 with autoscaling on 60 % CPU. worker 0.5 vCPU / 1 GB: staging 1, prod 2. A monthly cost estimate (AWS Pricing Calculator) is approved before the first apply |
| TLS to the data stores | The image ships the Amazon RDS global CA bundle (downloaded at build, pinned by SHA-256) and sets `NODE_EXTRA_CA_CERTS`, because Node does not trust that CA and the app verifies the server certificate when `DB_SSL` is on. Redis through `rediss://` with the AUTH token; RabbitMQ through `amqps://` |
| Secrets and config | One Secrets Manager secret per sensitive key per env, injected as task env vars. Terraform generates the DB password (`random_password`, so it lives only in the encrypted, access-restricted state) and writes `DATABASE_URL`, `REDIS_URL` and `RABBITMQ_URL`. The JWT key pair and the Kashier and Mailjet keys are put in by hand and never pass through Terraform. Every non-secret env key is set explicitly in the task definition from Terraform variables (no defaults, CLAUDE.md §4). One DB role owns the schema and serves the app in R1 |
| Edge | `api.staging.<domain>` (and `api.<domain>` at go-live) with an ACM certificate (DNS validation) on the ALB, HTTP → HTTPS redirect, `TRUST_PROXY_HOPS = 1`. `API_DOCS_ENABLED` true in staging, false in prod. `INVITE_URL_BASE` and `KASHIER_REDIRECT_URL` may be placeholder https URLs in staging; the mobile team's app links are required for prod |
| Pipelines | `deploy.yml` (switched on in Phase 9 by the repository variable `DEPLOY_ENABLED`): CI green on `main` → build the image once, push to **ECR** tagged with the git SHA → `node dist/migrate.js latest` as a one-off ECS task (a non-zero exit stops the deploy) → update the api and worker services → wait until both are stable. A `production` job behind a GitHub environment with required reviewers, used at go-live. `infra.yml`: on PRs touching `infra/`, `terraform fmt -check`, `validate` and a Trivy config scan per root, plus `plan` per env with the read-only role from Phase 9; `apply` only by hand. All AWS access through GitHub OIDC; no long-lived keys. Staging admins are created with a documented `aws ecs run-task` of `seed-admin.js` |
| Alerting | CloudWatch log groups with retention (staging 14 days, prod 90). Metric filters and alarms → an SNS email topic: `level` error / fatal, events sent to a DLQ, ALB 5xx, unhealthy targets, RDS CPU and free storage. Still no metrics endpoint or error-tracking service (SD-4) |
| Scanning | Trivy in CI for the image (OS and npm packages) and the Terraform code, failing on high / critical; a one-off gitleaks scan of the git history (P8-Q14) |

---

## 14. Release 2 [v2.0, approved 2026-10-20]

Inputs: `docs/spec/00-overview.md` v2.0 §10 (answers §10.8–§10.11), specs 01–20 Release 2 sections. §1–§13 still describe Release 1; this section stays separate (R2-Q1). Decisions in §14.11 (A-5…A-10, answered 2026-10-20).

### 14.1 Runtime topology
```
        Web app (app.<domain>)                     browser push services (FCM, Mozilla, Apple, WNS)
           │ HTTPS + WSS        │ direct upload (presigned POST)          ▲
   ┌───────▼────────┐           ▼                                         │ Web Push (VAPID)
   │ ALB            │      ┌──────────┐   CloudFront (media.<domain>) ◄── public images
   │ /api/v1/* ─────┼─► api│ S3 media │◄──────────────── worker (sharp) ─┘
   │ /realtime* ────┼─► realtime (Socket.IO) ◄── Redis adapter ── worker (redis-emitter)
   └────────────────┘      └──────────┘
```

| Process | New in R2 | Scaling |
|---|---|---|
| `api` | Media upload tickets (signs presigned POST / GET locally, no S3 call except `HEAD` + one range `GET` on complete), notification centre, support, reviews, returns, coupons, back-office | As §1 |
| `realtime` (**new**, `node dist/realtime.js`) | Socket.IO gateway, WebSocket transport only (so no sticky sessions), JWT handshake, rooms, client signals. Shares Redis through `@socket.io/redis-adapter` (RT-1, RT-7) | 2 tasks × 0.25 vCPU / 0.5 GB to start; autoscaling on CPU and connection count after the R2-P8 socket load test |
| `worker` | + image processing (`media.processing`), realtime fan-out (Redis emitter), push sending, refunds (Kashier secret key, PA-25), new jobs (§14.5). Now needs Redis (reverses spec 06 CA-8) and S3 | 2 tasks; size per A-6 |

### 14.2 Module dependency graph (full edge list; supersedes §2's table)

| Module | May call |
|---|---|
| identity | audit |
| customers | identity, catalog (product cards, new), audit |
| sellers | identity, audit |
| delivery | identity, audit |
| media | none |
| catalog | sellers, inventory, media (new), audit |
| inventory | none |
| promotions (**new**) | sellers, catalog, audit |
| cart | customers, catalog, inventory, sellers, media (new), promotions (new) |
| payments | audit |
| ordering | customers, cart, catalog, sellers, inventory, payments, delivery, media (new), promotions (new), audit |
| support (**new**) | ordering, customers, sellers, identity, media, audit |
| reviews (**new**) | ordering, catalog, customers, sellers, media, audit |
| returns (**new**) | ordering, inventory, payments, delivery, media, audit |
| finance | sellers, delivery, returns (new, holding release), audit |
| notifications | customers, sellers, delivery, ordering (recipient resolution, spec 02 §6.3) |
| realtime (**new**) | customers, sellers, delivery, ordering, support |
| backoffice (**new**) | identity, customers, sellers, ordering, support, finance, delivery, returns |
| audit (**new**) | identity (actor emails of the audit-log views, v2.1) |

- **Ordering is no longer a sink.** In R1 nobody called ordering. In R2 support, reviews, returns, notifications, realtime and backoffice read it through its public API (spec 09 §8.1). None of them is reachable from ordering, so the graph stays acyclic; `module-graph.js` is updated with this table and keeps failing CI on a cycle.
- **Audit writes go through `lib/audit`** (v2.1, spec 20 BO-9): `IAuditRecorder` and the action catalogue are shared-kernel contracts, like event contracts, so a module with admin writes depends on `lib`, not on the audit module. `record(entry, trx)` runs in the caller's transaction (spec 20 §2.2). The rows `… | audit` above therefore are not module edges.
- **`lib/realtime`** (the Redis emitter behind `IRealtimeEmitter`) is infrastructure, not a module edge, like `lib/events`.

### 14.3 Lock order (supersedes §3.1's line)
`return_requests` → `carts` (checkout only) → `orders` → `seller_orders` (by id) → `inventory_items` (by id) → `payments` → `coupons`.
- Returns completion is the only path that starts at `return_requests`; nothing locks a return after an order (spec 18 UC-RE-7).
- `coupons` is last both in checkout (`redeem`) and in the close step (`release`), so a hot coupon row is held for the shortest time and never waits on stock (spec 19 UC-PR-2).
- Module-local orders: support ticket → `media_objects` (claim); review → product stats → seller stats (spec 17 §1.2); finance accounts by id (FI-3); media rows by id inside `claim`.

### 14.4 Messaging
- New queues and bindings: `docs/spec/02-events.md` §6 (the source of truth, A-1).
- **Deploy order for changed payloads** (OR-22): payloads only gain fields or change meaning in a way equal to R1 when no coupon is used, and the consumers of a changed event ship **before** the publisher starts setting the new fields (release notes per R2 phase).
- `media.processing` runs with prefetch 1 per worker task (CPU-heavy), the other queues keep their prefetch. Implemented as an optional `prefetch` on `EventHandlerDefinition` that overrides `RABBITMQ_PREFETCH` for that queue (v2.3).
- Media deletes the original upload with `lib/db` `afterCommit` once the status change commits, so a rolled-back record never loses its input.
- `lib/http` gains `HTTP_STATUS.ACCEPTED` (202), used only for real asynchronous work (CLAUDE.md §7; spec 14 ME-3).
- Consumers with external effects (push sending, image processing) use the `beforeTransaction` step (§3.2).

### 14.5 Scheduled jobs (worker, advisory-locked)
| Job | Every (env) | What it does |
|---|---|---|
| `media-cleanup` | `JOB_MEDIA_CLEANUP_INTERVAL_MS` | Spec 14 UC-ME-4 |
| `support-jobs` | `JOB_SUPPORT_INTERVAL_MS` | Auto-close, SLA flag (spec 16 UC-SU-5) |
| `notification-retention` | `JOB_NOTIFICATION_RETENTION_INTERVAL_MS` | In-app rows older than 90 days (spec 13 UC-NO-5) |
| `returns-jobs` | `JOB_RETURNS_INTERVAL_MS` | Seller decision timeout, escalation lapse, inspection timeout (spec 18 UC-RE-9) |
| `payment-refunds` | `JOB_PAYMENT_REFUND_INTERVAL_MS` | Automated Kashier refunds (spec 10 UC-PA-6) |
| `seller-hold-release` | `JOB_SELLER_HOLD_RELEASE_INTERVAL_MS` | Holding period (spec 12 §8.3) |
| `audit-retention` | `JOB_AUDIT_RETENTION_INTERVAL_MS` | Audit rows older than 2 years (spec 20 §2.4) |

All follow the P5-Q5 pattern: candidates read without locks, one row per short transaction with `FOR UPDATE SKIP LOCKED`.

### 14.6 Caching (Redis)
| Data | Strategy | Invalidation |
|---|---|---|
| Admin dashboard | One value `v1:backoffice:dashboard`, TTL `DASHBOARD_CACHE_TTL_SECONDS` (60) | None (age shown as `generatedAt`) |
| Product detail | Unchanged key; now also holds the images (CDN URLs are immutable) | Every image write (spec 06 §8.2) |
| Category tree | Unchanged key; now also holds category images | Category image set / remove |
| Socket.IO adapter | Redis pub/sub channels of `@socket.io/redis-adapter` | n/a (transient) |

Ratings live on the product and seller rows (read fresh), so no rating is cached.

### 14.7 Security specifics (R2)
- **Uploads:** presigned POST with exact key, exact `Content-Type`, `content-length-range` and a 5-minute expiry; magic-byte check on complete; `sharp` with `limitInputPixels` (50 MP) and `failOn: 'error'`; every output re-encoded to WebP without metadata (EXIF / GPS stripped); originals deleted; private media only through presigned GET URLs to authorised viewers (ME-1). Bucket: public access blocked, objects encrypted (SSE-S3), CORS `POST` from `CORS_ALLOWED_ORIGINS` only, CloudFront reads `public/*` through Origin Access Control.
- **Sockets:** `Origin` allow-list (cross-site WebSocket hijacking), the R1 JWT verifier with the suspended-user deny entry, disconnect at `exp`, 4 KB inbound buffer, 5 signals / s per socket, handshake rate limit; messages carry ids and statuses only (no PII).
- **Web tokens (R-21):** refresh cookie `__Secure-nile_rt` `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`, read only with `X-Nile-Client: web`; CORS with credentials for exact origins only (spec 03 §8.1).
- **Push:** endpoint host allow-list checked on register and again before sending (SSRF guard); RFC 8291 payload encryption; no PII on the lock screen (R-7).
- **Sensitive data at rest:** COD refund payout details (wallet number, InstaPay address) are AES-256-GCM encrypted with the S-1 key in returns and payments, decrypted only in the admin refund detail endpoint, and added to the logger's redaction keys.
- **Kashier refunds:** the worker now holds `KASHIER_SECRET_KEY` (PA-25); its egress uses the allow-listed NAT IPs (K-7).
- **Audit:** every admin write in the same transaction as the change; `UPDATE` blocked by a trigger (BO-2); actor, IP and correlation id taken from the request context only.
- R2-P8 runs the upload and socket parts of the security review (overview §10.5).

### 14.8 Capacity check (R2 additions)
| Concern | Estimate | Verdict |
|---|---|---|
| Sockets | ~10 % of daily active users online at peak; with ~20k DAU at the design horizon → ~2k concurrent sockets, ~1 message / socket / min | 2 × 0.25 vCPU gateway tasks; Socket.IO handles ~10k idle sockets per core. Measured in R2-P8 |
| Fan-out | ~10 events per order × 20k orders/day peak → ~2.5 emits/s average | Trivial for Redis pub/sub |
| Image processing | ~2k sellers × ~20 images/month + review / support images → < 5k images/day; `sharp` ≈ 0.2–0.5 s CPU per image for 3 sizes | < 1 CPU-hour/day; fits the worker with prefetch 1 (A-6) |
| Media storage | ~300k variants × ≤ 8 images × ~150 KB (3 WebP sizes) ≈ ≤ 360 GB at the horizon | S3 + CloudFront, no capacity concern; cost in the estimate |
| Push | ≤ ~10 pushes per order → ~200k / day peak, each one HTTPS call | Worker, `PUSH_HTTP_TIMEOUT_MS`; queue absorbs bursts |
| Ledger growth | + holds, releases, return and refund entries ≈ +30 % rows | Same verdict as §11 |

### 14.9 Hosting additions (Terraform, applied with R2 after P9)
| Concern | Decision |
|---|---|
| Media bucket | One private S3 bucket per env (`nile-<env>-media`), SSE-S3, versioning off (objects are immutable, keys never reused), lifecycle rule deleting `uploads/*` after 2 days, CORS for the web origin. New module `s3-media` |
| CDN | CloudFront distribution over `public/*` with Origin Access Control, `media.<domain>` (A-8), long immutable caching. New module `cdn` |
| Realtime | ECS service `realtime` from the same image, ALB listener rule `/realtime*` → its target group, health check `/health/live`, ALB idle timeout 120 s (A-7) |
| IAM | api task role: `s3:PutObject` (signing for `uploads/*`), `s3:GetObject` on `uploads/*` and `private/*` (HEAD, range read, presigned GET), `s3:DeleteObject` on `uploads/*`. worker task role: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on the bucket. realtime: no S3 |
| Secrets | New: `VAPID_PRIVATE_KEY` (by hand). `KASHIER_SECRET_KEY` and `KASHIER_MERCHANT_ID` now also injected into the worker |
| Local dev / tests | MinIO in docker-compose and in Testcontainers, a bucket created at start-up (compose: a one-shot `minio-init` with the image's own `mc`, `public/*` anonymously readable in place of CloudFront; host ports 9100 / 9101). Image: `pgsty/minio`, pinned release tag (v2.2): `minio/minio` is no longer on Docker Hub and upstream publishes source only, so the community build of the same server is used; `STORAGE_PROVIDER = minio` is refused in deployed envs (F-3 pattern) |
| Alarms | + DLQ alarms for the new queues (existing metric filter), realtime unhealthy targets, `PAYMENT_REFUND_GAVE_UP` and `MEDIA_PROCESSING_STUCK` log events |

### 14.10 New dependencies (CLAUDE.md §1: each needs approval, A-9)
| Package | Why | Where |
|---|---|---|
| `@aws-sdk/client-s3`, `@aws-sdk/s3-presigned-post`, `@aws-sdk/s3-request-presigner` | Presigned uploads / downloads, HEAD, range GET, put, delete (works with MinIO through `endpoint` + `forcePathStyle`) | `pkg/storage` |
| `sharp` | Decode, rotate, strip metadata, resize, WebP encode; native, ships prebuilt binaries for linux-x64 | `pkg/image` (worker) |
| `socket.io`, `@socket.io/redis-adapter`, `@socket.io/redis-emitter` | Gateway, cross-task delivery, emitting from the worker | `realtime`, `lib/realtime` |
| `web-push` | VAPID signing and RFC 8291 encryption (R-20) | `pkg/push` |
| `socket.io-client` (dev) | Integration tests of the gateway | `test/` |

No cookie library: the api reads one cookie, parsed by a small helper in `lib/http` (the `cookie` header is already redacted in logs). Exact versions are pinned in the R2 implementation plan.

### 14.11 Decisions (answered 2026-10-20)

The user accepted every recommendation (2026-10-20). The table is kept for the reasoning; the answers are logged in §12.1 (A-5…A-10).

| # | Topic | Options / recommendation |
|---|---|---|
| A-5 | Hosting of the web app | **Rec:** out of this repository: the web team hosts `app.<domain>` (static hosting or its own service); we provide CORS origins, the cookie domain rules and the realtime URL · or a static S3 + CloudFront site in our Terraform |
| A-6 | Where images are processed | **Rec:** in the worker, queue `media.processing` with prefetch 1, and the worker task raised to 1 vCPU / 2 GB in prod so a burst of uploads can't slow the other consumers noticeably · or a separate `media-worker` ECS service from the same image |
| A-7 | ALB for sockets | **Rec:** the existing ALB with a `/realtime*` rule; its idle timeout goes to 120 s for every target (harmless for the api) · or a second ALB for realtime |
| A-8 | CDN domain | **Rec:** `media.<domain>` with an ACM certificate in `us-east-1` (CloudFront requirement) · or the default `*.cloudfront.net` domain (no DNS work, uglier URLs) |
| A-9 | New dependencies | **Rec:** approve the §14.10 list · or name the packages to replace |
| A-10 | Object storage in tests | **Rec:** MinIO through Testcontainers in integration tests, an in-memory `IObjectStorage` fake in unit tests (the pattern of the email and payment gateways) · or LocalStack S3 |
