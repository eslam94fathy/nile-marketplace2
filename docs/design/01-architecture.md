# System Design 01 — Architecture (Release 1)

Status: **v1.2 APPROVED (2026-10-08).** v1.1: event names and queue bindings now follow `docs/spec/02-events.md` v1.0 (A-1). v1.2: consumers with external effects run them before the dedupe transaction (§3.2, Phase 1). SD-3d (region, §12.2) is still open and only blocks Terraform provisioning. Changes from now on need explicit approval and a version bump.
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
           │      cart ─────► inventory       │
           │        ▲                         │
           └─── ordering ──► catalog, sellers, customers, inventory, payments, delivery(fee lookup only)

     payments ──► (none)          finance ──► (none)          notifications ──► (none: the recipient email is in the event payload)
```

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
- Lock ordering inside checkout, to avoid deadlocks: inventory rows are locked/updated **sorted by `inventory_item.id`**.

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
| `kashier-payment-expiry` | 30 s | `pending_payment` orders older than 15 min → payment `expired`, seller orders `cancelled`, reservations released, all in one trx (batched, `SKIP LOCKED`). Before expiring, it asks Kashier for the payment status so it doesn't race a late success (SD-5) |
| `seller-acceptance-timeout` | 1 min | `placed` seller orders with `accept_deadline_at < now()` → `cancelled` (reason `seller_acceptance_timeout`) |
| `shipment-assignment-retry` | 1 min | Retry auto-assignment for `unassigned` shipments |
| `outbox-cleanup` | daily | Delete dispatched outbox rows older than the retention period (env) |
| `processed-events-cleanup` | daily | Delete dedupe rows older than the retention period |
| `expired-codes-cleanup` | daily | Delete expired/consumed OTPs and invite tokens, and revoked/expired refresh tokens older than the retention period |

## 7. Key flows

### 7.1 Checkout (`POST /api/v1/checkout`, Idempotency-Key required)
1. Validate the DTO (`addressId`, `paymentMethod`). Load the cart (cart API).
2. Batch-load the variants with their product/seller data (catalog API, one query) and the seller status/commission/pickup snapshot (sellers API, one query). Reject if any variant is inactive or deleted, or any seller is not approved.
3. Load the address (customers API). Get the governorate fee (delivery API). Reject if the governorate isn't deliverable.
4. Compute the money with `decimal.js` (spec §5).
5. **One transaction:**
   - `inventory.reserve(items, trx)`: an atomic conditional update per item, sorted by id. Any shortfall → `409 INSUFFICIENT_STOCK` with the affected variant ids.
   - Insert `orders`, `seller_orders`, `order_items`, and the status history.
   - `payments.createForOrder(trx)` (COD → `pending`, Kashier → `initiated`).
   - `cart.clear(trx)`.
   - Outbox `order.placed` (COD only; for Kashier, `placed` happens on payment).
   - Commit.
6. The response includes the order. For Kashier, it also includes what the app needs to open the Kashier payment page (session created **after** commit; SD-5 covers the failure case).

### 7.2 Kashier webhook (`POST /api/v1/webhooks/kashier`)
- Verify the signature over the **raw body** using the secret from env. Invalid → `401`, logged at `warn` (no payload in logs).
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
| Category tree + attributes | Cache-aside, TTL from env | Deleted on any admin category/attribute change (same request, after commit) |
| Governorates + fees | Cache-aside | Deleted on fee change |
| Product detail (public) | Cache-aside, short TTL | Deleted after commit on product/variant change. Stock is **not** taken from cache at checkout |
| Product lists / search | **Not cached in R1.** Indexed queries are enough at the target load | n/a |

- Cache keys use constants with a version prefix (`v1:catalog:category-tree`).
- Redis failures degrade to reading from the DB, logged at `warn`. They never fail the request.
- Rate limiting and idempotency **fail closed** on sensitive routes (auth, checkout) and fail open elsewhere (config).

## 9. Search & filtering (catalog)

- Postgres FTS: a `products.search_vector` generated column (name weight A, description weight B) + GIN index. A `pg_trgm` GIN index on name handles typos and partial words. Text search configuration: `english` [SD-1].
- Filters, from a whitelist:
  - `category` (includes descendants: the ids come from the cached tree, then `category_id = ANY(?)`)
  - `price[gte|lte]` (on the denormalized `min_price`)
  - `inStock`
  - `seller`
  - `attr[<code>]=<optionCode,...>`: `EXISTS` subqueries through `variant_attribute_values`
- Sort: `newest` (`created_at, id`), `price_asc/desc` (`min_price, id`), `relevance` (search only). All use cursor pagination.

## 10. Security specifics

- JWT: **RS256** [SD-11]. The private key (PEM, from a secret env var) exists only in `api`; the public key is used for verification. Tokens carry a `kid` header so keys can be rotated (the old public key stays valid until its tokens expire). The access token TTL comes from env. Refresh tokens are opaque random 256-bit strings, stored as SHA-256 hashes, rotated on every use, and reuse revokes the family.
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

### 12.2 Open

- **SD-3d Region:** no residency requirement, so the region is chosen for latency to Egypt + service availability. Proposed: **`eu-central-1` (Frankfurt)**: ~50–60 ms from Cairo, and new RDS Postgres majors and Amazon MQ land there early. Alternative: `me-central-1` (UAE). Awaiting confirmation.

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
| Images | GitHub Container Registry or the provider's registry, tagged with the git SHA | Same image as prod | Built locally |
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

Region: see SD-3d.
