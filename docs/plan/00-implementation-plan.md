# Implementation Plan (Release 1)

Status: **P0 v1.0 APPROVED (2026-10-08) and implemented. P1 (§3) v1.0 APPROVED (2026-10-08) and implemented (see the P1 status after §3.6). P2 (§4) v1.0 APPROVED (2026-10-09). P3 (§5) v1.0 APPROVED (2026-10-10). P4 (§6) v1.0 APPROVED (2026-10-11) and implemented (see the P4 status after §6.6). P5 (§7) v1.0 APPROVED (2026-10-12); PR (a) and PR (b) implemented (see the P5 status after §7.6). P6 (§8) v1.0 APPROVED (2026-10-12) and implemented. P7 (§9) v1.0 APPROVED (2026-10-13) and implemented. P8 (§10) v1.0 APPROVED (2026-10-13) and implemented (see the P8 status after §10.7).** Later phases are detailed when their specs are approved.
Inputs: `CLAUDE.md`, `docs/design/01-architecture.md` v1.9, `docs/design/02-database.md` v1.12, `docs/spec/01-api-conventions.md` v1.3, `docs/spec/02-events.md` v1.1. Module phases also need their module spec (03–13) approved.

---

## 1. Phase order

Each phase ends green in CI (lint, type-check, unit, integration, build, Docker build, audit) and is one reviewable PR (or a short series of them). A module phase starts only after its spec is approved and the §8.2 changes it depends on are applied.

| Phase | Content | Needs approved |
|---|---|---|
| **P0** | **Foundation**: tooling, `lib/`, `pkg/`, health, outbox + broker + consumer framework, jobs runner, Docker, CI. No business module | This plan |
| P1 | identity + notifications (registration skeleton, login, refresh, OTP, invites, Mailjet) | Specs 03, 13 |
| P2 | delivery reference data (governorates, settings) · customers · sellers | Specs 04, 05, part of 11 · A-2 |
| P3 | catalog + inventory | Specs 06, 07 |
| P4 | cart | Spec 08 |
| P5 | ordering + payments (checkout, Kashier, expiry and timeout jobs) | Specs 09, 10 · A-3 |
| P6 | delivery: agents, shipments, assignment | Spec 11 · D-2, D-3 |
| P7 | finance | Spec 12 |
| P8 | Hardening: security review, AWS readiness, Terraform and pipelines written (no AWS), local load-test baseline, runbooks | This plan (§10) |
| P9 | Staging deploy: cost estimate, first apply, secrets, deploy pipeline on, checks on staging (Kashier, Mailjet, walkthroughs), load test at prod sizes against the targets, restore drill | AWS accounts, a domain, staging keys (user) |

P0–P8 are detailed below (§2–§10). P9 gets its own section when the user is ready to deploy staging.

---

## 2. Phase 0: Foundation

### 2.1 Decisions to approve (P0-Q)

| # | Topic | Options / recommendation |
|---|---|---|
| P0-Q1 | Local Node version | This machine runs **Node v25**. The stack is Node 24 LTS (D1). **Rec:** install Node 24 via nvm-windows and add `.nvmrc` (`24`) + `"engines": { "node": ">=24 <25" }` with `engine-strict`, so a wrong version fails `npm ci` |
| P0-Q2 | Module system | **Rec: CommonJS** output (`"type": "commonjs"`, `module`/`moduleResolution: NodeNext`), like the reference. Knex CLI migrations, tsyringe and decorators work with it without loader tricks · or ESM (needs `.js` suffixes in every import and an ESM-aware Knex setup) |
| P0-Q3 | Dev runtime and decorator metadata | esbuild-based runners (`tsx`, plain Vitest) **don't emit `design:*` decorator metadata**, which `class-validator-jsonschema` needs for the OpenAPI spec and tsyringe uses for injection. **Rec:** dev = `tsc --watch` + `node --watch --env-file=.env dist/server.js`; tests = Vitest with `unplugin-swc` (SWC emits the metadata). Every constructor parameter still uses `@inject(TOKEN)` · or `tsx` in dev and accept incomplete docs in dev |
| P0-Q4 | API docs exposure (CLAUDE.md §1 left this to system design) | **Rec:** `GET /api/v1/docs/openapi.json` + Swagger UI at `/api/v1/docs`, both behind `API_DOCS_ENABLED` (env, no default): `true` in dev/staging, `false` in production · or always public |
| P0-Q5 | JWT library | **Rec: `jose`** (typed, no dependencies, RS256 + `kid` + JWKS-ready) · or `jsonwebtoken` (reference) |
| P0-Q6 | Rate limiting | **Rec: `rate-limiter-flexible`** (Redis-backed, atomic, well maintained) · or a hand-written Redis Lua limiter |
| P0-Q7 | RabbitMQ client | **Rec: `amqplib` + `amqp-connection-manager`** (reconnects, confirm channels; the reference uses it) · or raw `amqplib` with our own reconnect |
| P0-Q8 | Scheduled jobs | **Rec:** our own small interval runner in `lib/jobs` (`setTimeout` loop + `pg_try_advisory_lock`, architecture §6). No cron library: all jobs are fixed intervals · or `croner` (reference) |
| P0-Q9 | Integration-test isolation | **Rec:** one Postgres/Redis/RabbitMQ container set per test run (Testcontainers global setup). Migrations run once into a template DB, and **each test file gets its own database** (`CREATE DATABASE … TEMPLATE`), Redis key prefix, and RabbitMQ vhost, so files run in parallel safely · or truncate all tables before each test (simpler, serial only) |
| P0-Q10 | Git | The folder **isn't a git repository**. **Rec:** `git init`, default branch `main`, first commit = docs + CLAUDE.md, then P0 on a branch `p0-foundation`. The remote (GitHub repo) is created by you |
| P0-Q11 | Dependency list | §2.3. Each one needs approval (CLAUDE.md §1) |

### 2.2 Scope

**In P0**

| Area | Files (under `src/` unless noted) | Notes |
|---|---|---|
| Tooling | `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.mjs`, `.prettierrc`, `vitest.config.ts`, `.editorconfig`, `.nvmrc`, `.gitignore`, `.env.example` | TS flags from CLAUDE.md §11. ESLint: `no-floating-promises`, `no-misused-promises`, `no-explicit-any`, `no-console` (except the logger writer), **boundary rules** (§2.4) |
| `pkg/time` | `toMs`, `toSeconds`, `addDuration`, `TimeUnit` | G2 |
| `pkg/crypto` | `sha256Hex`, `randomToken(bytes)` (base64url), constant-time compare, `ISecretBox` + AES-256-GCM implementation with a key ring | `02-events.md` §3.1 (S-1) |
| `pkg/cache` | `ICache` + Redis adapter | |
| `pkg/messaging` | `IMessageBroker` (publish with confirms, consume with manual ack) + RabbitMQ adapter | |
| `lib/config` | zod env schema (infrastructure keys only in P0), typed `env`, fail fast on bad keys (names only) | No defaults (G6) |
| `lib/logger` | `ILogger`, JSON stdout writer, levels, ISO timestamps, redaction list, error serialisation, circular/BigInt-safe, `child()`, correlation id from AsyncLocalStorage | CLAUDE.md §9.2 |
| `lib/context` | AsyncLocalStorage request/job context (`correlationId`, `userId`) | |
| `lib/clock` | `IClock` + system clock | |
| `lib/money` | `Money` (decimal.js, EGP, `ROUND_HALF_UP`, string serialisation) + rate helper | CLAUDE.md §6.2 |
| `lib/di` | container, `TOKENS` (infrastructure only in P0) | |
| `lib/db` | Knex instance (pool, `statement_timeout` from env), `ITransactionRunner`, `ping()`, PG error → `AppError` mapper with a constraint-name registry | |
| `lib/error` | `AppError`, common error codes + factories (`01-api-conventions.md` §6), global error handler, `unhandledRejection`/`uncaughtException` handlers | |
| `lib/http` | `HTTP_STATUS`, response helpers (envelope), strict `validate()` (class-validator options from §7), custom validators (`@MaxBytes`, `@AtLeastOneField`, `IsMoney`, `IsRate`, `IsEgyptianMobile`), cursor codec, list-query parser (whitelist map, operators, sort), OpenAPI builder (`class-validator-jsonschema` + `openapi3-ts`) + docs route | |
| `lib/middleware` | correlation id, request-completion log, auth guard (RS256 via `jose`, pinned alg, `iss`/`aud`/`exp`) + role guard, rate limiter (classes from `01-api-conventions.md` §7, fail closed/open per route), idempotency (lock, fingerprint, replay, TTL), 404 | |
| `lib/events` | `contracts/` (**all 22 event contracts** from `02-events.md`: name, version, payload type), `IOutbox.add(trx, event)`, outbox drain (`SKIP LOCKED`, confirms, backoff), consumer framework (queue + retry + DLQ topology from `02-events.md` §2, `processed_events` dedupe in the handler's transaction, correlation restore) | Business consumers are registered by their phase |
| `lib/jobs` | advisory-locked interval runner + cleanup jobs (`outbox-cleanup`, `processed-events-cleanup`) | Other jobs come with their modules |
| `app/health` | `GET /health/live`, `GET /health/ready` (Postgres, Redis, RabbitMQ, each with a timeout) | |
| Entrypoints | `app.ts` (Express pipeline, architecture §4), `server.ts`, `worker.ts`, graceful shutdown (timeout from env) | `node dist/server.js` / `node dist/worker.js` |
| Migrations | `pg_trgm` extension · `events_outbox` · `processed_events` (exactly as in `02-database.md` §12) | Module tables come with their phase |
| Docker | multi-stage `Dockerfile` (deps → build → runtime, `node:24-*-slim`, non-root, `HEALTHCHECK` → `/health/live`), `.dockerignore`, `docker-compose.yml` (`postgres:18`, `redis`, `rabbitmq:management`, api, worker, one-off migrate service) | CLAUDE.md §12 |
| CI | `.github/workflows/ci.yml`: `npm ci` → lint → type-check → unit → integration (Testcontainers) → build → Docker build → `npm audit --audit-level=high` | |
| Tests | `test/helpers` (containers, per-file DB/vhost, app factory, JWT test keys) | §2.5 |

**Not in P0:** business modules and their tables, Mailjet/Kashier adapters (P1/P5), Terraform (P8).

### 2.3 Dependencies (P0-Q11)
Exact versions are pinned at install time (`save-exact=true` in `.npmrc`), using the latest stable release that is ≥ 2 weeks old, and recorded in the lockfile.

Runtime:

| Package | Why |
|---|---|
| `express` (5) | HTTP (CLAUDE.md §1) |
| `helmet`, `cors` | §7 |
| `knex`, `pg` | DB + migrations |
| `ioredis` | Redis |
| `amqplib`, `amqp-connection-manager` | RabbitMQ (P0-Q7) |
| `tsyringe`, `reflect-metadata` | DI |
| `zod` | Env validation |
| `class-validator`, `class-transformer` | DTOs |
| `class-validator-jsonschema`, `openapi3-ts` | OpenAPI (O6) |
| `swagger-ui-express` | Docs UI (P0-Q4) |
| `decimal.js` | Money (O3) |
| `jose` | JWT (P0-Q5) |
| `rate-limiter-flexible` | Rate limits (P0-Q6) |

`bcrypt` is added in P1. Email and Kashier use Node's built-in `fetch`, so they need no SDKs. `.env` loading uses Node's `--env-file`, so no `dotenv`.

Dev: `typescript`, `@types/node` (24), `@types/express`, `@types/cors`, `@types/swagger-ui-express`, `@types/amqplib`, `@types/supertest`, `eslint`, `typescript-eslint`, `eslint-plugin-boundaries`, `eslint-config-prettier`, `prettier`, `vitest`, `@vitest/coverage-v8`, `unplugin-swc`, `@swc/core`, `supertest`, `testcontainers`, `@testcontainers/postgresql`, `@testcontainers/redis`, `@testcontainers/rabbitmq`.
Type packages go in `devDependencies` (the reference had them in `dependencies`).

### 2.4 Enforced boundaries (ESLint, from day one)
- `pkg/**` can't import `lib/**` or `app/**`. `lib/**` can't import `app/**`.
- `app/<m>/**` can import another module only through `app/<other>/index.ts`.
- `app/**` can't import `migrations/**`.
- The allowed module-to-module edges (architecture §2 + A-2 once approved) are listed in the config. Anything else is a lint error, which keeps the graph acyclic.

### 2.5 P0 tests

| Kind | Covers |
|---|---|
| Unit | `pkg/time`, `pkg/crypto` (round trip, tamper detection, key rotation), `Money` (rounding, arithmetic, serialisation), cursor codec, list-query parser (ops, types, unknown field/op → `INVALID_QUERY`), `validate()` (unknown key, nested, error details), logger (redaction, error serialisation, circular refs, level filter), PG error mapper |
| Integration | `/health/live`, `/health/ready` (200, and 503 per dependency with a stopped container), correlation id (accept valid / reject invalid / generate / echo / present in logs), error envelope (404 route, 400 validation, malformed JSON, 413, 500 without stack), auth guard (missing / expired / wrong `alg` / wrong `aud` / wrong role), rate limit (429 + `Retry-After`), idempotency (replay, in-progress 409, reuse 422, 5xx not stored), outbox → RabbitMQ round trip (publish, consume, dedupe on redelivery, retry → DLQ), advisory-locked job runs once with 2 workers |

Test-only routes (a `/__test` router mounted only by the test app factory) exercise the middlewares before real endpoints exist. They are never mounted by `server.ts`.

### 2.6 Order of work (one commit each, in this order)
1. `git init`, `.gitignore`, docs commit (P0-Q10).
2. Tooling: package.json, tsconfig, ESLint (with boundaries), Prettier, Vitest, `.nvmrc`, `.npmrc`, `.env.example`.
3. `pkg/time`, `pkg/crypto` + unit tests.
4. `lib/config`, `lib/context`, `lib/logger`, `lib/clock` + tests.
5. `lib/error`, `lib/http` (status, response, validate, custom validators, cursor, query parser) + tests.
6. `lib/money` + tests.
7. `lib/db`, migrations (extension, outbox, processed_events), `lib/di`.
8. `app.ts`, `server.ts`, middlewares, `app/health`, OpenAPI route + integration harness and tests.
9. `pkg/cache`, `pkg/messaging`, `lib/events` (contracts, outbox, drain, consumer framework), `lib/jobs`, `worker.ts` + tests.
10. Docker, docker-compose, CI workflow.

### 2.7 Done when
- CI is green on the P0 branch: lint, type-check, unit, integration, build, Docker build, audit.
- `docker compose up` starts Postgres/Redis/RabbitMQ + api + worker, migrations apply, `GET /health/ready` → `200` with all three dependencies `up`, and stopping Redis turns it into `503`.
- `GET /api/v1/docs/openapi.json` returns a valid OpenAPI 3 document (health only, for now).
- No `any`, no `console.*` outside the logger writer, no `process.env` outside `lib/config`.

**P0 status (2026-10-08): implemented** on branch `p0-foundation` (9 commits). Deviations from §2.3: TypeScript 6.0.3 instead of 7 (typescript-eslint supports TS < 6.1); `eslint-plugin-boundaries` replaced by a local rule in `eslint-rules/` (its dependency chain had 4 unfixable high audit findings); `@types/amqplib` dropped (amqplib 2 ships its types). Design notes: the outbox drain claims rows with a lease and publishes outside any transaction (CLAUDE.md §6.4); migrations are listed explicitly in `src/migrations/index.ts`.

---

## 3. Phase 1: identity + notifications

Status: **v1.0 APPROVED (2026-10-08).** All P1-Q recommendations accepted; P1-Q8 answered (Mailjet account available, sender verified as Active).
Needs approved: spec `03-identity.md` and spec `13-notifications.md` (both still DRAFT v0.1), plus the P1-Q decisions below. It does **not** need A-2 / D-2 / D-3: identity and notifications call no other module.

### 3.1 What P1 delivers, and what it can't yet
- Identity end to end for admin-created accounts: seed the first admin (CLI), invite admins, accept an invite, login, refresh rotation with reuse detection, logout, forgot/reset password, change password, suspend/reactivate, resend invite, list admins.
- The transactional emails (verification OTP, password reset OTP, invite) go identity → outbox (secrets encrypted) → worker → notifications → email provider.
- **Self-registration is P2**: its routes live in `customers` / `sellers` (spec 03 §1). In P1, `identity.createPendingUser` and the email-verification endpoints are built and integration-tested through the module's public API; their HTTP end-to-end test lands with P2.

### 3.2 Decisions to approve (P1-Q)

| # | Topic | Options / recommendation |
|---|---|---|
| P1-Q1 | Secrets per process | Today one env schema is shared by api, worker and migrate, so adding the JWT **private** key or Mailjet keys would hand them to every process. **Rec:** a base schema + per-process extensions: api adds `JWT_PRIVATE_KEY`, `JWT_ACTIVE_KID`, token TTLs, OTP/invite settings, `BCRYPT_COST`; worker adds the email-provider keys; both get `SECRETS_ENCRYPTION_*` (api encrypts, worker decrypts); migrate gets DB only · or keep one schema |
| P1-Q2 | Email in development and tests | **Rec:** `EMAIL_PROVIDER` env (`mailjet` \| `mailpit`). Local dev uses a **Mailpit** container (new compose service, pinned version; web inbox at :8025, sent through its HTTP API, so no SMTP library). Integration tests use an in-memory sender injected through DI. Staging/prod: `mailjet` · or Mailjet sandbox mode everywhere |
| P1-Q3 | bcrypt library (D10) | **Rec: `bcrypt@6.0.0`** (native, ships prebuilt binaries loaded at runtime, so it works with `npm ci --ignore-scripts`; verified in the slim Docker image as part of P1) · or `bcryptjs` (pure JS, ~3× slower per hash) |
| P1-Q4 | Values for spec 03 / S-16 settings | **Rec:** `BCRYPT_COST=12`, OTP 10 min / 5 attempts / 60 s cooldown, invite 72 h, access token 15 min, refresh token 30 days (all env, no defaults) |
| P1-Q5 | JWT signing keys | **Rec:** `JWT_PRIVATE_KEY` (PEM, api only) + `JWT_ACTIVE_KID`; the matching public key must be in `JWT_PUBLIC_KEYS`. Rotation: add the new public key, deploy, switch `JWT_ACTIVE_KID`, remove the old public key after the access-token TTL |
| P1-Q6 | Invite link format (`INVITE_URL_BASE`) | The app opens it, so the mobile team must agree. **Rec:** an https universal/app link (e.g. `https://<domain>/invite?token=…`), which email clients handle better than a custom scheme. The code only appends `?token=`; the value can be decided before staging |
| P1-Q7 | First-admin seed | **Rec:** `node dist/seed-admin.js --email <email>` (in Docker: `docker compose run --rm api node dist/seed-admin.js --email …`). Creates an invited admin and queues the invite email. Refuses an existing email; never prints the token |
| P1-Q8 | Mailjet account | **Answered:** account available; sender address verified (status Active, checked 2026-10-08). Keys live only in the git-ignored `.env` locally and in Secrets Manager for staging/prod |

### 3.3 Scope

| Area | Content |
|---|---|
| Migrations | `users`, `refresh_tokens`, `verification_codes`, `notification_log`: one migration per table, exactly as `02-database.md` §2 and §12 |
| `pkg/` | `hashing` (`IPasswordHasher` + bcrypt adapter), `email` (`IEmailSender` + Mailjet adapter via `fetch` + Mailpit adapter) |
| `lib/` | env split (P1-Q1); `lib/auth` `JwtSigner` (api only); shared `UserRole` reused |
| `app/identity` | full module layout (CLAUDE.md §2.1): routes, controllers, services, repositories, models, DTOs, enums, errors, constraint registrations (`uq_users_email` → `EMAIL_ALREADY_REGISTERED`), public API (§2 of spec 03), OpenAPI docs for every endpoint |
| `app/notifications` | `notifications.email` consumer, templates in the repo (S-15), `notification_log` repository, permanent vs transient failure handling (spec 13 §3) |
| Jobs | `expired-codes-cleanup` (architecture §6) |
| CLI | `seed-admin` |
| Docker | Mailpit service in compose; `.env.example` and `dev:env` updated with the new keys |
| Boundaries | `module-graph.js` unchanged (identity and notifications import no module) |

### 3.4 Tests
- **Unit** (services with mocked repositories/clock/hasher through DI): token rotation decisions, reuse detection, OTP attempt counting and expiry, cooldowns, generic responses, template rendering, permanent vs transient email failures.
- **Integration, per endpoint** (CLAUDE.md §12): happy path, validation failure, authz failure (where authenticated), not-found (where it applies). Plus:
  - refresh reuse revokes the whole family; two concurrent refreshes of the same token → exactly one succeeds
  - login: wrong password and unknown email give the same response; invited and suspended accounts
  - OTP: wrong code counts attempts; after `OTP_MAX_ATTEMPTS` even the right code fails; a new code invalidates older ones
  - password reset and suspension revoke all sessions; password change keeps only the current session
  - strict-auth rate limits on every public auth endpoint
  - email pipeline end to end: request → outbox row with **no plain-text OTP/token** in the payload → worker consumer → fake sender received the decrypted OTP → `notification_log` row; redelivery doesn't send twice
  - `seed-admin` CLI against a test database

### 3.5 Order of work (one commit each)
1. Env split per process (P1-Q1) + `.env.example` / `dev:env` / compose updates.
2. `pkg/hashing`, `pkg/email` (+ Mailpit service), `JwtSigner` + unit tests.
3. Identity migrations.
4. Identity: repositories, models, token/OTP services + unit tests.
5. Identity: auth endpoints (verify, resend, login, refresh, logout, forgot/reset, change password, invite accept) + integration tests + OpenAPI.
6. Identity: admin endpoints + `seed-admin` CLI + `expired-codes-cleanup` job + tests.
7. Notifications: migration, consumer, templates, adapters wiring + end-to-end email test.

### 3.6 Done when
- CI green; every P1 endpoint is in the OpenAPI document with its DTOs.
- Locally: `seed-admin` → invite email visible in Mailpit → accept → login → refresh → logout works through the API.
- No plain-text OTP, invite token, password or refresh token in any log line, outbox row or broker message (asserted by tests).

**P1 status (2026-10-08): implemented** on branch `p1-identity` (§3.5 steps 1–7, plus docs and DB-Q6; PR stacked on `p0-foundation`). Locally green: lint, type-check, Prettier, unit (144), integration (122), build, `npm audit` (0). Manual local walkthrough **passed (2026-10-08)** on the docker-compose stack rebuilt from this branch: `seed-admin` → invite email in Mailpit (`notification_log` `sent`) → accept (a second accept `INVALID_INVITE_TOKEN`) → login → admin route `200` → refresh (reusing the old token revokes the session) → logout (refresh afterwards `401`); the invite token and the password appeared in no api/worker log line and no outbox row. **Still to do for "done when":** a green CI run on the PR. Deviations from §3.3–§3.5: none in scope. Clarifications made during implementation and accepted: spec 01 v1.1 (passwords never trimmed, `Optional()`), spec 03 v1.1 §7.1 (I-1…I-9), spec 13 v1.1 §7.1 (N-1…N-5), architecture v1.2 §3.2 (`beforeTransaction` for external effects), database v1.3 (`notification_log` FK + failure check). Extra shared code: async rate-limit keys (`emailRateKey`), `InvitationService` without bcrypt (for the CLI). DB-Q6 (admin list index) decided and added as migration `20261008135708` (database v1.4).

---

## 4. Phase 2: delivery reference data · customers · sellers

Status: **v1.0 APPROVED (2026-10-09).** All P2-Q recommendations accepted; the branch `p2-customers-sellers` is stacked on `p1-identity`.
Needs approved: spec `04-customers.md`, spec `05-sellers.md`, the P2 part of spec `11-delivery.md` (§1 governorates + `delivery_settings`, §2 `getGovernorateFees` / `getAgentFeeShareRate`, UC-DE-7, §4.1, and the four admin governorate/settings endpoints in §4.3), all three still DRAFT v0.1, plus **A-2** (architecture §2 dependency edges). It does **not** need D-2 / D-3 (shipments, P6) or A-3 (checkout, P5).

### 4.1 What P2 delivers, and what it can't yet
- **delivery (reference data only):** the 27 governorates with their fees, the agent fee-share setting, `GET /governorates`, and the admin endpoints that change fees and the setting. Agents, shipments, and assignment stay in P6.
- **customers:** self-registration, profile, and addresses, plus the public API that cart and ordering will call.
- **sellers:** self-registration, profile, re-apply, the admin approval lifecycle, per-seller and default commission, and the `seller.approved` / `seller.suspended` events. These events have no consumer until catalog lands in P3. They are published anyway (spec 02 §2).
- The self-registration → verify OTP → login HTTP end-to-end test that P1 deferred (§3.1) lands here.

### 4.2 Decisions to approve (P2-Q)

| # | Topic | Options / recommendation |
|---|---|---|
| P2-Q1 | Approvals | Approve specs 04 and 05, the P2 part of spec 11 (listed above), and A-2. A-2 also adds `cart → sellers` and `finance → sellers, delivery`. Those edges only matter in P4/P7, but approving A-2 as a whole keeps `module-graph.js` to one edit. **Rec:** approve all four as written, plus the clarifications in P2-Q2…Q8 |
| P2-Q2 | bcrypt runs inside the registration transaction | `identity.createPendingUser` hashes the password itself, and the caller passes in its transaction. So bcrypt (cost 12, ~250 ms) holds a pooled connection while the new user row is locked, which breaks P1-I2. **Rec:** identity exposes `hashPassword(plain) → PasswordHash` (a branded type only identity can create). customers/sellers call it **before** opening the transaction, and `createPendingUser` takes `passwordHash: PasswordHash` instead of `password` (spec 03 §2 v1.2) · or identity runs the transaction and takes a callback for the profile insert (hands identity control of another module's transaction, so not recommended) |
| P2-Q3 | Governorate name language | The schema has one `name VARCHAR(100)`. **Rec:** English names (ISO 3166-2:EG), with the app showing its own Arabic label keyed by `code`, which never changes · or add `name_ar VARCHAR(100)` and return both (DB change D-5, plus a response-shape change in spec 11 §4.1) |
| P2-Q4 | Seeded delivery fees | **Rec:** the migration seeds all 27 governorates with `delivery_fee = NULL`, so nothing is deliverable until an admin sets fees (real fees are business data, not code). A `dev-seed` script sets sample fees for local dev only · or you give me the real fee for each governorate and the migration seeds them |
| P2-Q5 | Governorates cache | Architecture §4 says cache-aside, deleted on fee change, but defines no TTL. **Rec:** Redis key `v1:delivery:governorates`, new env `GOVERNORATES_CACHE_TTL_SECONDS` (value 3600, no default), deleted after commit on a fee change. `delivery_settings` is not cached (a one-row lookup) |
| P2-Q6 | Address concurrency + the "first address is default" rule | Spec 04 UC-CU-2 is read-then-write (count for the limit, "is this the first?", clear the old default). **Rec:** every address write first locks the customer row (`SELECT … FROM customers WHERE id = ? FOR UPDATE`). Default rule: a new address becomes the default **whenever the customer has no live default**. That covers the first address and the case where the default was deleted · or only when the customer has zero live addresses (then, after the default is deleted, new addresses stay non-default until the customer picks one) |
| P2-Q7 | `GOVERNORATE_NOT_FOUND` used by three modules | customers and sellers may not import delivery, yet all three raise this code (customers/sellers through their FK). **Rec:** put the code and factory in the `lib/error` common errors (shared kernel, CLAUDE.md §2.2 rule 6), and have each module register its own FK constraint name against it · or each module declares the same string in its own `errors.ts` |
| P2-Q8 | Public API methods that only later phases call | customers `getAddressSnapshot`, sellers `getStatuses` / `getSummaries` / `getCheckoutSnapshots`, delivery `getGovernorateFees` / `getAgentFeeShareRate`. **Rec:** build and test them now through the public API, so each module is finished in one go and P3–P5 can rely on them · or add each one in the phase that first calls it |

### 4.3 Scope

| Area | Content |
|---|---|
| Docs | Specs 04, 05 → v1.0; spec 11 → v1.0 for the P2 parts (agent/shipment parts unchanged); spec 03 → v1.2 (P2-Q2); architecture → v1.3 (A-2); overview §8.2 A-2 → Applied; `module-graph.js` gains the A-2 edges |
| Migrations (in FK order) | `governorates` (+ 27-row seed), `delivery_settings` (+ seed `0.7000`), `customers`, `customer_addresses`, `sellers`, `seller_status_history`, `seller_commission_history`, `seller_settings` (+ seed `0.1000`). One migration per table, exactly as in `02-database.md` §3, §4, §10 |
| `lib/` | `GOVERNORATE_NOT_FOUND` common error (P2-Q7); `money` / `rate` DTO decorators if P1 didn't already add them |
| `app/identity` | `hashPassword` + `createPendingUser(passwordHash)` (P2-Q2), with tests updated |
| `app/delivery` | Module skeleton (reference-data part only): governorate + settings repositories, `GovernorateService` with cache, `GET /governorates`, `GET/PATCH /admin/governorates…`, `GET/PUT /admin/settings/delivery`, public API, OpenAPI |
| `app/customers` | `POST /auth/register/customer`, `GET/PATCH /me`, the five `/me/addresses` endpoints, public API, constraint mapping (`fk_customer_addresses_governorate_id` → `GOVERNORATE_NOT_FOUND`), env `CUSTOMER_MAX_ADDRESSES` (20) |
| `app/sellers` | `POST /auth/register/seller`, `/seller/profile` (get, patch, reapply), every `/admin/sellers…` and `/admin/settings/commission` endpoint, the status machine with history rows, commission history, the `seller.approved` / `seller.suspended` outbox events, public API, constraint mappings (`uq_sellers_business_name_lower` → `BUSINESS_NAME_TAKEN`, `fk_sellers_pickup_governorate_id` → `GOVERNORATE_NOT_FOUND`) |
| Indexes | Only those in `02-database.md`. `businessName like` on the admin seller list runs without a trigram index (~2k sellers in year 1; revisit if it shows up in the P8 load tests) |
| Tooling | Postman collection regenerated (`scripts/make-postman.js`); `dev-seed` for local governorate fees (P2-Q4) |

### 4.4 Tests
- **Unit:** seller state machine (every allowed and refused transition), commission change and `COMMISSION_RATE_UNCHANGED` (compared as `Decimal`, so `"0.1"` equals `"0.1000"`), address default rules, governorate cache hit / miss / invalidation.
- **Integration, per endpoint** (CLAUDE.md §12): happy path, validation failure, authz failure (wrong role and anonymous), not-found. Plus:
  - registration end to end: register a customer / seller → OTP email in the fake sender → verify → login. Duplicate email `409`. Duplicate business name (different case) `409` with **no** user row left behind (one transaction). Unknown governorate `422`
  - registration never puts the plain password or OTP in a log line or outbox row
  - addresses: the limit holds under parallel creates; parallel "set default" leaves exactly one default; another customer's address `404`; deleting the default leaves none
  - sellers: approving before email verification `409`; two parallel approvals → one `200`, one `409`; each transition writes one history row; approve / reinstate / suspend write the right outbox event with the right payload; reject / suspend without a reason `400`
  - the default commission applies only to sellers registered after the change
  - admin seller list: filters, `like`, cursor pagination, emails filled from one batched identity call
  - governorates: a fee change invalidates the cache (the next public read shows it); `null` fee → `isDeliverable: false`
  - strict-auth rate limits on both register endpoints

### 4.5 Order of work (one commit each)
1. Docs: approvals applied (spec versions, A-2, `module-graph.js`).
2. identity: `hashPassword` + `createPendingUser(passwordHash)` (P2-Q2) + tests.
3. delivery: governorates + `delivery_settings` migrations and seeds, module skeleton, cache, endpoints, public API, tests.
4. customers: migrations, registration + profile + addresses, public API, tests (including the deferred P1 end-to-end).
5. sellers: migrations and seed, registration + self-service + reapply, public API, tests.
6. sellers admin: list, detail, transitions, events, commission, settings, tests.
7. Postman collection, `dev-seed`, `.env.example`, plan status.

### 4.6 Done when
- CI green; every P2 endpoint is in the OpenAPI document with its DTOs.
- Locally (docker-compose + Mailpit): register a seller → OTP in Mailpit → verify → admin approves → `seller.approved` row in the outbox, published to RabbitMQ. Register a customer → verify → login → add two addresses → switch the default.
- No plain-text password or OTP in any log line, outbox row, or broker message (asserted by tests).

**P2 status (2026-10-09): implemented** on branch `p2-customers-sellers` (stacked on `p1-identity`; §4.5 steps 1–7). Locally green: lint, type-check, Prettier, unit (182), integration (187, two consecutive full runs), build. Manual local walkthrough **passed (2026-10-10)** on the docker-compose stack rebuilt from this branch (the 8 P2 migrations applied by `migrate`, `seed:dev` fees visible at once): seller register → OTP in Mailpit → verify → admin approve (`approvedAt` set, two history rows) → `seller.approved` outbox row dispatched to RabbitMQ; customer register → verify → login → two addresses (the first became the default) → default switched; `notification_log` `sent` for the invite and both verification emails; the password and the OTPs appeared in no api/worker log line and no outbox row. **Still to do for "done when":** a green CI run on the PR. Deviations from §4.3–§4.5: none in scope. Extra shared code: the spec 01 DTO shorthands as decorators in `lib/http/validation/fields.ts` (`EmailField`, `PasswordField`, `StrField`, `PhoneField`, `UuidField`; identity now uses them) and `Nullable()`. Found during P2: Postgres 18 raises `23001` for `ON DELETE RESTRICT`, which the error mapper doesn't map yet (CLAUDE.md §14.2 P2-O1); a timing race in the P1 notifications redelivery test, fixed in the test (`0aedf08`). Local sample fees: `npm run seed:dev`.

---

## 5. Phase 3: catalog + inventory

Status: **v1.0 APPROVED (2026-10-10).** All P3-Q recommendations accepted; the branch `p3-catalog-inventory` is stacked on `p2-customers-sellers`.
Needs approved: spec `06-catalog.md` and spec `07-inventory.md` (both v1.0 now), plus the P3-Q decisions below. It does **not** need A-3 (checkout, P5). Overview §8.2 O-2 (API surface) stays pending until every module spec is in; the stock-adjustments route from S-6 is part of it.

### 5.1 What P3 delivers, and what it can't yet
- **catalog:** the admin category tree with attributes and options, seller products and variants, seller stock adjustments and stock history, public browse, search and product detail, the listing projections (`seller_active`, `in_stock`, `min_price` / `max_price`), and `getVariantsForPurchase` for cart (P4) and ordering (P5).
- **inventory:** stock rows, `createItem`, `adjust`, `getStockByVariantIds`, `listMovements`, the movement audit trail, and the `inventory.stock_status_changed` event.
- **Not yet:** reservations (`reserve` / `release` / `commit`) and the `inventory_reservations` table (P3-Q2). They land in P5 with checkout.
- The `seller.approved` / `seller.suspended` events from P2 get their first consumer (`catalog.listing-projections`).

### 5.2 Decisions to approve (P3-Q)

| # | Topic | Options / recommendation |
|---|---|---|
| P3-Q1 | Approvals | **Rec:** approve specs 06 and 07 → v1.0 with the clarifications in P3-Q2…Q12 written into them |
| P3-Q2 | `inventory_reservations` references `order_items`, which P5 creates | **Rec:** P3 builds `inventory_items` + `inventory_movements` and the non-reservation methods. The reservations table (with its FK) and `reserve` / `release` / `commit` land in P5 with ordering, as one migration, so the FK exists from the start · or create the table now without the FK and add it in P5 (two-step migration, and the methods can't be tested against real order lines yet) |
| P3-Q3 | Read-then-write races in catalog | Recomputing `min_price` / `max_price` / `in_stock`, the 100-variant limit, "one default variant", and "activate needs an active variant" are all read-then-write. **Rec:** every product or variant write (and the `in_stock` consumer) starts with `SELECT … FROM products WHERE id = ? FOR UPDATE`, then checks and recomputes. Admin category, attribute and option writes lock the affected category row (the parent on create), which covers the child limit, the 5-attribute limit and the lineage code check. Same pattern as P2-Q6. Lock order is product → inventory item everywhere, and checkout (P5) never locks products, so there's no cycle |
| P3-Q4 | Seller suspended while a product write is in flight | The guard reads `approved`, a suspension commits, its consumer flips `seller_active` on the existing rows, and then the in-flight insert commits with `seller_active = true` for a suspended seller. **Rec:** sellers gains `getSellerByUserId(userId, { trx, lockShared: true })` (`FOR SHARE`). The catalog guard calls it inside the write transaction, so a suspension waits for the write and its consumer sees the new row (spec 05 → v1.1) · or accept the race (rare, but it leaves a suspended seller's product visible until the next seller event) |
| P3-Q5 | `attr.<code>` filter semantics | (a) Do several `attr.*` filters have to match **the same** variant? `attr.size=xl&attr.color=red` should not match a product sold only as XL-blue and S-red. (b) Codes are unique only within a lineage, so `size` can exist under Clothing and Shoes with different options. **Rec:** one `EXISTS` over the product's **active, non-deleted** variants that carries every `attr.*` condition (same variant). `attr.*` **requires** `categoryId`. Codes resolve against the attributes of that category, its ancestors and its descendants, and an option code may then map to several option ids. An unresolved code → `400 INVALID_QUERY` · or each filter independently on any variant (cheaper, but returns wrong matches) |
| P3-Q6 | List query language extensions (`lib/http/query`) | Products need three things the shared parser doesn't have: dynamic `attr.*` fields, custom filters (`categoryId` → descendant ids, `attr.*` → `EXISTS`), and a computed sort (`relevance`). **Rec:** extend `ListSpec` generically: a `prefixFields` entry (`attr.` → validator), a per-field `apply(qb, filter)` hook, and a sort `expression` (raw SQL with bound params) instead of a column. The relevance sort value is `round((ts_rank(…) + similarity(…))::numeric, 6)`, carried in the cursor as a string, so keyset comparisons are exact (a float `real` in a cursor can skip or repeat rows) · or parse the products query inside catalog only (duplicates the cursor and limit logic) |
| P3-Q7 | Public "newest" sorts on `created_at` | A product created as a draft in March and activated in June lists as a March product. **Rec:** public `sort=publishedAt` replaces `createdAt` (VIS implies `published_at` is set). The two public listing indexes become `(…, published_at DESC, id DESC) WHERE VIS` (**D-5**, database v1.5). The seller list keeps `createdAt` · or keep `created_at` as in the spec |
| P3-Q8 | Stock history cursor without an `id` tie-break | `idx_inventory_movements_inventory_item_id_created_at` has no `id`, but cursor pagination needs `(sort_col, id)` (CLAUDE.md §6.3). **Rec:** **D-6**: `idx_inventory_movements_inventory_item_id_created_at_id (inventory_item_id, created_at DESC, id DESC)` instead (database v1.5) |
| P3-Q9 | Caches | **Rec:** `v1:catalog:category-tree` holds the full admin tree with attributes and options (public views are derived in memory), env `CATEGORY_TREE_CACHE_TTL_SECONDS` = 3600. `v1:catalog:product:<id>` holds the static product detail (no stock, no live quantities), env `PRODUCT_DETAIL_CACHE_TTL_SECONDS` = 60. A slug is resolved to an id with one indexed lookup, so there's only one key per product. Deleted after commit by every product/variant write, by the seller-status consumer (it uses `UPDATE … RETURNING id` to know which keys), and by the `in_stock` consumer. Both new env keys go in the api and worker schemas, with no defaults |
| P3-Q10 | When `inventory.stock_status_changed` is emitted | **Rec:** only `adjust` emits it (and P5 `reserve` / `release`), when sellable crosses 0. `createItem` doesn't, and neither do variant status changes or deletes, because catalog recomputes `in_stock` in that same transaction. The consumer always recomputes from current stock, so its order doesn't matter, and it ignores deleted products |
| P3-Q11 | Deleting an attribute or option vs. a concurrent variant insert (P2-O1) | The app check passes, a variant using the option commits, and the `DELETE` fails with `23001` (`ON DELETE RESTRICT`) → today a `500`. **Rec:** resolve P2-O1 now: `PgErrorMapper` maps `23001` → `409 CONFLICT` by default, and catalog registers `fk_variant_attribute_values_option_id` → `OPTION_IN_USE`, `fk_variant_attribute_values_attribute_id` → `ATTRIBUTE_IN_USE`. Deleting an attribute deletes its options first, in the same transaction (explicitly, no `CASCADE`) |
| P3-Q12 | Small spec gaps | **Rec:** (a) when kebab-casing the name leaves nothing usable, the product slug is `product-<6 base36>` and a category create without `slug` → `422 CATEGORY_SLUG_REQUIRED`; (b) `GET /seller/variants/:id/stock-movements` is allowed in any seller status, like other seller reads; (c) the seller `name like` filter runs without a trigram index (seller-scoped, small); (d) `seed:dev` gains a sample tree (with attributes and options) and an approved seller with a few products, for the mobile team |

### 5.3 Scope

| Area | Content |
|---|---|
| Docs | Specs 06, 07 → v1.0; spec 05 → v1.1 (P3-Q4); database → v1.5 (D-5, D-6); architecture → v1.4 (cache keys, `published_at` sort); overview §8.2 D-5, D-6; CLAUDE.md §9.1 + §14 (P2-O1 resolved, P3-Q decisions) |
| Migrations (in FK order) | `categories`, `category_attributes`, `category_attribute_options`, `products`, `product_variants`, `variant_attribute_values`, `inventory_items`, `inventory_movements`. One migration per table, as in `02-database.md` §5–§6 with D-5 and D-6. `inventory_reservations` waits for P5 (P3-Q2) |
| `lib/` | List query extensions (P3-Q6); `23001` mapping (P3-Q11); `slugify` in `pkg/` |
| `app/sellers` | `getSellerByUserId` with `{ trx, lockShared }` (P3-Q4) |
| `app/inventory` | Module skeleton, no routes: repositories, `InventoryService` (`createItem`, `adjust`, `getStockByVariantIds`, `listMovements`), the outbox event, public API |
| `app/catalog` | Every endpoint in spec 06 §4.1–§4.3, the services, the tree cache and the product-detail cache, the seller guard, the projections, the `catalog.listing-projections` consumer (worker), `getVariantsForPurchase`, constraint mappings (spec 06 §6), OpenAPI |
| Module graph | Already allows `catalog → sellers, inventory`; no edit |
| Tooling | Postman collection regenerated; `seed:dev` sample catalog (P3-Q12 d); `.env.example` gets the two cache TTLs |

### 5.4 Tests
- **Unit:** effective attributes (inheritance and order), variant option validation (exactly one per effective attribute, the default variant), `option_signature`, slug generation, product projection recompute, status transitions, the stock-status crossing rule, the `attr.*` resolver, the list-query extensions (prefix fields, apply hooks, expression sort, cursor round trip).
- **Integration, per endpoint** (CLAUDE.md §12): happy path, validation failure, authz failure (wrong role, anonymous, a non-approved seller on writes), not-found (another seller's product → `404`). Plus:
  - categories: depth 4 refused; sibling name (different case) and slug conflicts `409`; deactivation refused with an active child or a product; the cache is invalidated after every admin change
  - attributes: a code clash with an ancestor or a descendant `409`; adding one to a subtree with products `409`; the 5-attribute limit; deleting an option in use `409`, including a concurrent variant insert (P3-Q11)
  - variants: the wrong option set `422` with details; a duplicate combination, a duplicate SKU (different case) and a second default variant `409`; deactivating the last active variant moves the product to `inactive`; `min_price` / `max_price` / `in_stock` are right after create, update and delete
  - concurrency: parallel variant creates respect the 100-variant limit and the single default; parallel stock adjustments never go below `reserved` or 0; a seller suspended during a product create leaves the product hidden (P3-Q4)
  - stock: adjustments need an `Idempotency-Key` (a replay returns the same body, a different payload `422`); movements are written with the right `on_hand_after`; crossing 0 writes exactly one outbox event
  - projections: `seller.suspended` hides every product of that seller from public lists and detail, `seller.approved` shows them again, and replays are harmless; `inventory.stock_status_changed` updates `in_stock`
  - public: hidden and deleted products `404`; `categoryId` includes descendants; `price`, `inStock`, `sellerId`, `attr.*` (same-variant rule, max 5 filters, unknown codes `400`, `attr.*` without `categoryId` `400`); `q` finds a typo through trigram; every sort with cursor pagination across pages, with no duplicates or gaps; `sort=relevance` without `q` `400`
  - `getVariantsForPurchase`: `purchasable` is false for each hidden case, all in one query

### 5.5 Order of work (one commit each)
1. Docs: approvals applied (spec 05/06/07 versions, D-5/D-6, CLAUDE.md).
2. lib: list query extensions + `23001` mapping, with tests.
3. inventory: migrations, module, public API, event, tests.
4. catalog admin: category/attribute/option migrations, tree cache, admin endpoints, tests.
5. catalog seller: product/variant migrations, sellers `lockShared`, seller endpoints, stock endpoints, projections, tests.
6. catalog public: browse, search, detail cache, `getVariantsForPurchase`, tests.
7. catalog consumer: `catalog.listing-projections` in the worker, tests.
8. Postman collection, `seed:dev`, `.env.example`, plan status.

### 5.6 Done when
- CI green; every P3 endpoint is in the OpenAPI document with its DTOs.
- Locally (docker-compose): admin builds a 3-level tree with attributes → an approved seller creates a product with variants and stock → activates it → it shows in `GET /products` (filtered by an attribute and found by a misspelt `q`) and in detail with live quantities → admin suspends the seller → the product disappears within seconds → reinstate → it's back. A stock adjustment to 0 flips `inStock` in the list.

**P3 status (2026-10-10): implemented** on branch `p3-catalog-inventory` (stacked on `p2-customers-sellers`; §5.5 steps 1–8). Locally green: lint, type-check, Prettier, unit (228), integration (258), build. The "done when" flow above is covered end to end by `test/integration/catalog-projections.test.ts` and `catalog-public-api.test.ts` (real Postgres, Redis, RabbitMQ). Manual local walkthrough **passed (2026-10-10)** on the docker-compose stack rebuilt from this branch (the 8 P3 migrations applied by `migrate`; the worker started `catalog.listing-projections`): `seed:dev` created the sample catalog (a re-run skipped it); admin (seed-admin invite from Mailpit) built a 3-level tree, the leaf inheriting `color` and adding `size`; a seller registered, verified the OTP, was approved, created a product with two variants and stock, and activated it; `GET /products` with `attr.color[in]=black&attr.size[in]=42` from the root category matched it and `…=43` did not; `q=trail runner` found it; the detail by slug showed live quantities (4 / 0) and the 3-level path; suspend → gone from the list in 0.9 s; reinstate → back in 1.1 s; stock adjusted to 0 → `inStock[eq]=false` in 0.9 s; both stock movements recorded; no password in any api/worker log line, no error or 5xx line. The first run found that a misspelt `q` (`trial runer`, `runer`) missed "Trail Runner …": `name % q` compares the whole name, and multi-word names scored under the 0.3 threshold (P3-O1). Fixed the same day: typo search now matches words (`q <% name`, env `SEARCH_WORD_SIMILARITY_THRESHOLD` 0.35, spec 06 v1.4 CA-14, still served by `idx_products_name_trgm` in a `BitmapOr` with the FTS index), with a regression test; the re-run on the rebuilt stack passed every step, misspelt searches included (and `q=erbuds` finds the seeded "Wireless Earbuds"). Locally green after the fix: unit (228), integration (259). **Still to do for "done when":** a green CI run on the PR. Decisions taken during implementation (all approved, recorded in spec 06 v1.1–v1.3, database v1.6 and CLAUDE.md §14.1f): D-7 `idx_products_category_id`; CA-13 an active category always has an active parent (`CATEGORY_PARENT_INACTIVE`); attribute writes lock the category's whole subtree and the 5-attribute limit is checked against the largest count in it; product writes hold their category `FOR SHARE`; the product-detail cache holds no visibility, prices or stock, so the projection consumers invalidate nothing and the worker has no Redis (CA-8). Deviations from §5.3–§5.5:
- All eight migrations landed in step 3, because `inventory_items.variant_id` references `product_variants`; steps 4–5 have none.
- List-query extension (P3-Q6): fields without a column are parsed and validated by the shared parser and applied by the caller, instead of a per-field `apply` hook, because their resolution needs async cache reads and all `attr.*` conditions form one `EXISTS`.
- Both cache TTL env keys are api-only: the worker needs neither.
- Shared code added: `pkg/text` `slugify`; `SlugField`, `IntField`, `IsPositiveMoney` in `lib/http`; spec 01 v1.3 (`23001` → `CONFLICT`).
- Test helpers: `test/helpers/catalog-fixtures.ts` (SQL fixtures) and `catalog-api.ts` (HTTP setup).
- Tooling: Postman collection regenerated (71 requests: "Catalog", "Admin: catalog", "Seller: catalog"); `npm run seed:dev` also creates a sample catalog (a 3-root tree with inherited attributes, an approved demo seller `demo-seller@nile.test` whose random password is reset through Mailpit, 4 active products with stock).

---

## 6. Phase 4: cart

Status: **v1.0 APPROVED (2026-10-11).** All P4-Q recommendations accepted; the branch `p4-cart` is stacked on `p3-catalog-inventory`.
Needs approved: spec `08-cart.md` and A-4 (both approved now: spec 08 v1.0, architecture v1.6), plus the P4-Q decisions below. It does **not** need A-3 or the inventory reservations (both P5).

### 6.1 What P4 delivers, and what it can't yet
- **cart:** one lazily created cart per customer, every endpoint in spec 08 §4 (view with live prices, stock and per-line `issue`, add / change / remove, empty), and the public API ordering will call (`getLinesForCheckout`, `clear`).
- **inventory:** the `INSUFFICIENT_STOCK` code and factory (P4-Q4). `reserve` / `release` / `commit` stay in P5.
- **Not yet:** checkout. Nothing calls `getLinesForCheckout` / `clear` until P5; P4 tests them directly.

### 6.2 Decisions to approve (P4-Q)

| # | Topic | Options / recommendation |
|---|---|---|
| P4-Q1 | Approvals | **Rec:** approve spec 08 → v1.0 with the clarifications in P4-Q2…Q11 written into it, and A-4. Branch `p4-cart` stacked on `p3-catalog-inventory` |
| P4-Q2 | **A-4**: missing dependency edge `cart → customers` | Spec 08 §1 says cart depends on `customers` (JWT `sub` → `customerId` via `getCustomerIdByUserId`), but architecture §2 and `eslint-rules/module-graph.js` only allow `cart → catalog, inventory, sellers`, so the lint rule would reject the import. **Rec:** add the edge (architecture v1.6, overview §8.2 A-4, one line in `module-graph.js`). Still acyclic: customers calls only identity · or key carts by `user_id` (breaks G12: role data hangs off the role table, not `users`) |
| P4-Q3 | Read-then-write races | "Max 50 lines", "summed quantity ≤ 99" and the lazy create are all read-then-write. **Rec:** every write starts by locking the cart row. Add creates and locks in one statement: `INSERT INTO carts (customer_id) VALUES (?) ON CONFLICT (customer_id) DO UPDATE SET updated_at = now() RETURNING id`. Change / remove / empty use `SELECT id FROM carts WHERE customer_id = ? FOR UPDATE` and never create a cart (no cart → `CART_ITEM_NOT_FOUND`, or a no-op `204` for `DELETE /cart`). Purchasability and stock are then read in the same transaction **without** locks (a soft check, spec 08 UC-CT-2). `carts` is always locked first, which is also what checkout does (`getLinesForCheckout` locks the cart before reserving), so there's no cycle · or rely on `uq_cart_items_cart_id_variant_id` + the `quantity` CHECK and accept that two parallel adds can make a 51st line |
| P4-Q4 | `INSUFFICIENT_STOCK` doesn't exist yet | Inventory's errors say the code "lands with `reserve` (P5)", but cart needs it now (same code, spec 08 §6). **Rec:** inventory adds `INSUFFICIENT_STOCK` + `insufficientStock(shortLines)` now and exports them, with the spec 01 details shape `[{ field: 'variantId', value, constraint: 'available', message: 'available: <n>' }]`. Cart throws it with one detail; `reserve` reuses it in P5 · or make it a common `lib/error` code (like `GOVERNORATE_NOT_FOUND`, P2-Q7), but inventory owns the stock rules |
| P4-Q5 | Which quantity the add checks use | **Rec:** add checks the **resulting** line quantity (existing + added) against 99 and against sellable; change checks the new absolute quantity. Changing or adding to a line whose variant isn't purchasable fails `422` even when decreasing (the customer removes it), as spec 08 already implies |
| P4-Q6 | A retried `POST /cart/items` doubles the quantity | Adds are summed, so a mobile retry after a timeout adds twice. CLAUDE.md §10 requires `Idempotency-Key` only for money or stock effects, and an add has neither (the stock check is soft). **Rec:** no `Idempotency-Key`, as in spec 08 (the doubled line is visible and fixable, and checkout needs `expectedTotal`, S-8) · or require it (one more header on the app's most frequent write) |
| P4-Q7 | Order and display rules the spec leaves open | **Rec:** (a) lines sort by `created_at, id` (when they were added), and seller groups sort by their earliest line, so the view stays stable as quantities change; (b) every line shows `unitPrice` and `lineTotal = unitPrice × quantity` (`Money`), but lines with an `issue` are left out of `subtotal`, `itemsTotal` and `itemCount`; a group whose lines all have issues still shows, with `subtotal` `"0.00"`; (c) `availableQuantity` is `0` for `UNAVAILABLE` and `min(sellable, 99)` otherwise; (d) `POST /cart/items` returns `201` also when it added to an existing line (spec 08 §4) |
| P4-Q8 | Where "seller not visible" comes from | **Rec:** from `purchasable` alone (spec 06: it includes the `seller_active` projection, which the P3 consumer updates within about a second of a suspension). Cart doesn't call `sellers.getStatuses`; checkout re-checks the live status with `getCheckoutSnapshots` (spec 09 step 4). Cart calls `sellers.getSummaries` only for display names |
| P4-Q9 | Edge cases in the lookups | **Rec:** (a) a customer-role token with no customer profile is an invariant violation (registration creates both in one transaction): non-operational `500`; (b) a cart line whose variant `getVariantsForPurchase` doesn't return can't happen (variants are only soft-deleted and the FK is `RESTRICT`), so it's left out of the view and logged at `error`; (c) an empty or missing cart returns `id: null`, `sellers: []`, totals `"0.00"` / `0`, and `GET` never creates a row |
| P4-Q10 | Limits and env | **Rec:** `CART_MAX_LINES` (50) in the **api** env schema only, no default, in `.env.example`. The 99 per line stays a constant: it mirrors the DB `CHECK`, so making it env would let the two disagree |
| P4-Q11 | Schema details `02-database.md` §7 leaves open | **Rec:** `fk_carts_customer_id … ON DELETE RESTRICT`; `fk_cart_items_variant_id … ON DELETE RESTRICT`; `fk_cart_items_cart_id … ON DELETE CASCADE` (as written). No index on `cart_items.variant_id`: nothing looks lines up by variant, and variants are never hard-deleted, so the `RESTRICT` check never runs. The reason goes in a SQL comment (database v1.7, wording only) |

### 6.3 Scope

| Area | Content |
|---|---|
| Docs | Spec 08 → v1.0; architecture → v1.6 (A-4); database → v1.7 (P4-Q11 wording); spec 07 → v1.1 (`INSUFFICIENT_STOCK` lands in P4); overview §8.2 A-4; CLAUDE.md §14 (P4-Q decisions) |
| Migrations | `carts`, `cart_items` (one each, raw SQL, as in `02-database.md` §7 with P4-Q11) |
| `app/inventory` | `INSUFFICIENT_STOCK` code + factory, exported (P4-Q4) |
| `app/cart` | Module skeleton; `CartRepository`, `CartItemRepository`; `CartService` (writes, P4-Q3), `CartViewService` (UC-CT-1: three batched calls, issues, grouping, `Money` totals), `CartDirectory` (public API); controller, routes (customer role, general limit), DTOs, errors (spec 08 §6), OpenAPI |
| Module graph | `cart: ['catalog', 'customers', 'inventory', 'sellers']` (A-4) |
| Composition roots | `registerCartModule` + router in the api; nothing in the worker (no events) |
| Tooling | Postman "Cart" folder; `.env.example` gets `CART_MAX_LINES` |

### 6.4 Tests
- **Unit:** issue classification (each case, and precedence `UNAVAILABLE` > `OUT_OF_STOCK` > `INSUFFICIENT_STOCK`), grouping and order (P4-Q7 a), `Money` totals (issue lines left out, an all-issue group), `availableQuantity` capping, the add/change rule checks (summed quantity, 99, line limit).
- **Integration, per endpoint** (CLAUDE.md §12): happy path, validation failure (quantity 0 / 100 / non-integer, bad uuid, unknown keys), authz failure (anonymous, seller, admin), not-found (another customer's line → `404`). Plus:
  - `GET` on a fresh account returns the empty shape and creates no row
  - adding twice sums into one line; a sum over 99 `422`; the 51st line `422`; an unknown, inactive, deleted or suspended-seller variant `422`; a quantity over sellable `409` with the details shape
  - the view: each issue appears after the matching catalog / inventory change (product deactivated, variant deleted, stock adjusted to 0 and to below the quantity, seller suspended → projection); a price change shows in the next `GET`; totals count only lines without issues
  - concurrency: parallel adds of different variants into a cart with 49 lines end with exactly 50; parallel adds of the same variant end with one line and the right sum; two parallel first adds create one cart
  - `DELETE /cart` empties the cart (and is a `204` with no cart)
  - public API: `getLinesForCheckout` returns the lines and blocks a second transaction on the same cart until the first commits; `clear` deletes every line inside the caller's transaction (and is rolled back with it)

### 6.5 Order of work (one commit each)
1. Docs: approvals applied (spec 07/08, architecture A-4, database v1.7, overview, CLAUDE.md), module graph edge.
2. inventory: `INSUFFICIENT_STOCK`, with a test.
3. cart: migrations, repositories, `CartDirectory`, tests.
4. cart: services, endpoints, OpenAPI, tests.
5. Postman collection, `.env.example`, plan status.

### 6.6 Done when
- CI green; every P4 endpoint is in the OpenAPI document with its DTOs.
- Locally (docker-compose): a customer adds variants from two sellers (from the `seed:dev` catalog) → `GET /cart` shows two seller groups with the right totals → one seller adjusts a variant's stock to 0 → that line shows `OUT_OF_STOCK` and drops out of the totals → admin suspends the other seller → its lines show `UNAVAILABLE` within seconds → reinstate → they're back → the customer changes a quantity, removes a line and empties the cart.

**P4 status (2026-10-11): implemented** on branch `p4-cart` (stacked on `p3-catalog-inventory`; §6.5 steps 1–5). Locally green: lint, type-check, Prettier, unit (255), integration (289), build. Every cart endpoint is in the OpenAPI document with `CartDto` and its nested DTOs. Manual local walkthrough **passed (2026-10-11)** on the docker-compose stack rebuilt from this branch (the 2 P4 migrations applied by `migrate`): a fresh customer's `GET /cart` returned the empty shape with `id: null` and created no row; adds from two sellers (a walkthrough seller and the `seed:dev` demo seller) gave two groups ordered by their earliest line, and adding the same variant again summed into one line; the totals matched the lines (`7696.00` / 6); the first seller adjusted the variant's stock to 0 → that line showed `OUT_OF_STOCK` and dropped out of the totals (`2698.00`); admin suspended the other seller → its lines showed `UNAVAILABLE` in 0.9 s (totals `0.00`) and changing one was refused with `422 VARIANT_NOT_PURCHASABLE`; reinstate → back in 1.1 s; the customer changed a quantity, removed a line and emptied the cart (the cart row stays). No password in any api/worker log line, no error or 5xx line. **Still to do for "done when":** a green CI run on the PR. Deviations from §6.3–§6.5:
- `CART_MAX_LINES` (env schema, test env, `dev-env.js`, `.env.example`) landed in step 4, not 5, because `CartService` needs it. Existing local `.env` files need `npm run dev:env` before the api restarts.
- A missing customer profile is a `500` in cart (CT-8), while the customers module answers `403` for the same case; both are as their specs say.
- The "seller suspended" integration tests set the `seller_active` projection directly instead of running the consumer (the P3 tests cover the consumer); the walkthrough above covers it end to end.
- Test infrastructure: the RabbitMQ Testcontainer gets a 120 s startup timeout (`test/helpers/global-setup.ts`); the module's 30 s default failed once on a busy Docker host (~32 s).
- Test helpers: `test/helpers/cart-fixtures.ts` (SQL fixtures for customers, carts and lines, on top of the catalog fixtures).
- Found during P4: Postgres raises `23001` (not `23503`) when deleting a row protected by an `ON DELETE RESTRICT` FK; the cart schema tests expect `23001` (already mapped to `409` since P3-Q11).
- Tooling: Postman collection regenerated (76 requests, new "Cart" folder; "Product detail" stores the first variant in `variantId`, "Add item" stores the added line in `cartItemId`).

---

## 7. Phase 5: ordering + payments

Status: **v1.0 APPROVED (2026-10-12).** All P5-Q recommendations accepted; the branch `p5-ordering-payments` is stacked on `p4-cart`.
Needs approved: spec `09-ordering.md` and spec `10-payments.md` (both v1.0 now), A-3 (architecture v1.7), the database changes in P5-Q4 (D-8, database v1.8), plus the P5-Q decisions below. It does **not** need D-2 / D-3 (shipments, P6) or spec 12 (finance, P7).

### 7.1 What P5 delivers, and what it can't yet
- **ordering:** checkout (COD and Kashier), the per-seller split with snapshots and money, customer / seller / admin order views, customer cancel, seller accept / ready / cancel / partial item cancel / return received, the stored order status and the close step, the `seller-acceptance-timeout` and `kashier-payment-expiry` jobs, and the consumers `ordering.payment-updates` and `ordering.shipment-updates` (P5-Q2).
- **payments:** the payment record per checkout, Kashier sessions through a `pkg/payments` gateway, the signed webhook, provider status lookups for the expiry job, the `payments.order-adjustments` consumer (refund flags, COD amounts), and the admin refund queue with manual refund recording.
- **inventory:** `inventory_reservations` and `reserve` / `release` / `commit` (P3-Q2, IN-1).
- **Not yet:** shipments (P6), so in a real run seller orders stop at `ready_for_pickup`; everything after that is driven in tests by publishing the `shipment.*` contract events. Finance (P7) consumes nothing yet.

### 7.2 Decisions to approve (P5-Q)

| # | Topic | Options / recommendation |
|---|---|---|
| P5-Q1 | Approvals and branch | **Rec:** approve spec 09 and spec 10 → v1.0 with the clarifications in P5-Q2…Q14 written into them; A-3 (architecture v1.7: §7.1 rewritten to the spec 09 §3.1 step order, order rows inserted before `inventory.reserve`); database v1.8 (D-8, P5-Q4); spec 07 v1.2 (reservations land). One branch `p5-ordering-payments` stacked on `p4-cart`, delivered as **two PRs**: (a) ordering + inventory reservations + COD payments, (b) Kashier (gateway, sessions, webhook, expiry job, admin refunds) · or one PR (about twice the size of P3) |
| P5-Q2 | Shipment-driven use cases before delivery exists | UC-OR-6/7/8 (picked up, out, failed, delivered + agent fee share + `inventory.commit`, return received) and the COD-collection part of UC-PA-3 only run once P6 emits `shipment.*`. **Rec:** build them in P5, so ordering and payments are each finished in one go (as P2-Q8), and test them by publishing the contract events in integration tests · or move them to P6 (P5 then ends at `ready_for_pickup` and cancellations) |
| P5-Q3 | Lock order across ordering, payments and inventory | Spec 09 §1.2 fixes `orders → seller_orders → inventory items` but doesn't place `payments`, and the expiry job (spec 09 §3.10 step 3) calls `payments.expire` *before* touching seller orders. **Rec:** one order everywhere: `carts` (checkout only) → `orders` → `seller_orders` (by id) → `inventory_items` (by id) → `payments`. The expiry job locks the order and its seller orders, releases stock, then calls `payments.expire`; `false` (the webhook won) rolls the transaction back and skips the order. The webhook never locks `orders` and the `ordering.payment-updates` consumer never locks `payments`, so there's no cycle |
| P5-Q4 | Schema gaps in `02-database.md` §8–§9 (**D-8**) | (a) `GET /admin/orders` without a status filter sorts every order by `-createdAt` with no index → add `idx_orders_created_at_id (created_at DESC, id DESC)`; (b) the admin payment view lists events per payment → add `idx_payment_events_payment_id (payment_id)`; (c) the refund queue is cursor-paginated → `idx_payment_refunds_created_at_id (created_at, id) WHERE status = 'pending_manual'` (adds the `id` tie-break, as D-6); (d) returning a still-valid Kashier session (P5-Q7) needs `payments.provider_session_url VARCHAR(500) NULL` and `provider_session_expires_at TIMESTAMPTZ NULL` (null for COD and before a session exists); (e) every FK `ON DELETE RESTRICT`; no indexes on `order_items.variant_id` / `product_id`, `inventory_reservations.inventory_item_id`, `payment_refunds.seller_order_id` (nothing looks them up, rows are never hard-deleted; reason in a SQL comment, as P4-Q11); (f) `order_number_seq` created in the `orders` migration. **Rec:** all of (a)–(f) |
| P5-Q5 | Jobs: batching and locking | Spec 09 §3.10 says "batch, `FOR UPDATE SKIP LOCKED` after locking their orders", which one statement can't do in the P5-Q3 order. **Rec:** each run reads up to `ORDER_JOBS_BATCH_SIZE` candidate order ids from the partial index without locks, then handles **one order per short transaction**: `SELECT … FROM orders WHERE id = ? FOR UPDATE SKIP LOCKED` (busy → left for the next run), then conditional updates on the expected status and deadline. A failing order is logged at `error` and doesn't stop the batch. The expiry job makes its provider calls per order **before** opening that order's transaction (CLAUDE.md §6.4) |
| P5-Q6 | Expiry job details (spec 09 §3.10) | **Rec:** (a) check the local payment first: already `paid` (webhook applied, consumer not run yet) → skip without calling Kashier, so the job doesn't loop on the provider; (b) provider says unpaid or is unreachable → **abandon the Kashier session** (best effort, logged on failure) and expire, so the customer can't pay into a cancelled order in most cases; one that still slips through is SD-5 (late payment → `paid` + full refund flag); (c) the session is created with `expireAt = payment_expires_at`, so Kashier stops accepting payment at the same moment |
| P5-Q7 | One Kashier session per payment (spec 09 §4.1.2) | Two sessions for one payment could both be paid. Session creation runs outside any transaction (after checkout commits, and from `POST /orders/:id/payment/kashier-session`), so two calls can race. **Rec:** `createKashierSession` returns the stored session while `provider_session_expires_at > now()`; otherwise it creates one and stores it with a conditional `UPDATE payments … WHERE id = ? AND status = 'initiated' AND provider_order_ref IS NULL`; the loser of a race abandons its own session and returns the winner's. No new session after the payment window (`ORDER_NOT_AWAITING_PAYMENT`) |
| P5-Q8 | Kashier integration details (spec 10 §1: "confirm at implementation") | Kashier's current docs ([payment sessions](https://developers.kashier.io/docs/accept-payments/payment-sessions), [webhooks](https://developers.kashier.io/docs/webhooks), [payloads](https://developers.kashier.io/docs/webhooks/payloads)) show v3 **payment sessions** (create with `expireAt`, amount, order id, per-session `serverWebhook`; response `sessionUrl`), an unauthenticated **get session** (status, history) and **abandon session**; webhooks are signed in `x-kashier-signature` as an HMAC over the alphabetically sorted `data.signatureKeys` values, keyed by the **payment API key** (spec 10 assumed a separate secret), and success is read from `data.status`, not `event`. **Rec:** use payment sessions; `fetchProviderStatus` = get session; spec 10 §1 config becomes `KASHIER_MERCHANT_ID`, `KASHIER_API_KEY` (api-key header + webhook HMAC), `KASHIER_SECRET_KEY` (Authorization header), `KASHIER_BASE_URL`, `KASHIER_MODE`, `KASHIER_REDIRECT_URL`, `KASHIER_WEBHOOK_URL`, `KASHIER_HTTP_TIMEOUT_MS`; `provider_event_id` = Kashier's own event/transaction id if the payload has one, else `<event>:<transactionId>:<status>`. All verified against the Kashier test environment before PR (b) merges. Needs a Kashier test account (like P1-Q8 for Mailjet) |
| P5-Q9 | Gateway in tests and local dev | Kashier can't reach `localhost` for webhooks. **Rec:** `PAYMENT_GATEWAY` env `kashier` / `fake` (no default, like `EMAIL_PROVIDER`; `fake` refused in staging/production). The fake returns a local `checkoutUrl` and keeps session state in memory; a dev-only script `npm run dev:kashier-webhook -- <paymentId> paid|failed` sends a correctly **signed** webhook to the local api, so the real verification path runs. Integration tests use the fake and the same signer. One manual run against the Kashier test environment (through a tunnel) before staging · or Kashier test mode only (a tunnel for every local run) |
| P5-Q10 | Env keys (process split, P1-Q1) | **Rec:** api: `PAYMENT_GATEWAY`, `KASHIER_*`, `KASHIER_PAYMENT_TTL_MINUTES` (15), `SELLER_ACCEPT_TIMEOUT_HOURS` (24, COD checkout sets the deadline). Worker: `PAYMENT_GATEWAY`, `KASHIER_*` without the redirect/webhook URLs (it only reads and abandons sessions), `SELLER_ACCEPT_TIMEOUT_HOURS` (the payment consumer sets the deadline), `JOB_SELLER_ACCEPTANCE_TIMEOUT_INTERVAL_MS` (60 000), `JOB_KASHIER_PAYMENT_EXPIRY_INTERVAL_MS` (30 000), `ORDER_JOBS_BATCH_SIZE` (100). No defaults; in `.env.example`, `dev-env.js` and the test env |
| P5-Q11 | Webhook edge cases | (a) The signature is checked before anything is stored, so an invalid one stores nothing and `payment_events.signature_valid` is always `true`. **Rec:** keep it (storing unsigned requests lets anyone fill the table); the column stays. (b) Amount mismatch on a successful payment: spec 10 marks the payment `failed` and cancels the order, while the customer's money was taken, and nothing tells an admin to refund it. **Rec:** also set `collected_amount` to the paid amount and flag a full refund with a new `RefundReason` `amount_mismatch`, so it appears in the refund queue · or log only and investigate by hand |
| P5-Q12 | Checkout response and idempotency | The `201` body (with `checkoutUrl`, possibly `null`) is what the idempotency layer stores and replays. **Rec:** keep it: a replay may show `checkoutUrl: null` and the app then calls `kashier-session`, which returns the stored session (P5-Q7). The `checkout` rate limit (per user, fail closed) covers `POST /checkout` and `kashier-session` |
| P5-Q13 | Read models | **Rec:** (a) seller business names in order views come live from `sellers.getSummaries` (seller orders keep no name snapshot; the shipment does in P6); (b) `OrderSummaryDto.itemCount` = Σ open quantities (`quantity − cancelled_quantity`); (c) detail views load seller orders, items and histories with one batched query each (no N+1); (d) `canCancel` is `false` while the order is `pending_payment` |
| P5-Q14 | `KASHIER_REDIRECT_URL` | Where Kashier sends the customer after paying. **Rec:** an https app link, like `INVITE_URL_BASE` (P1-Q6), value agreed with the mobile team before staging; the app never trusts the redirect and reads `GET /orders/:id` |

### 7.3 Scope

| Area | Content |
|---|---|
| Docs | Spec 09 → v1.0, spec 10 → v1.0 (P5-Q clarifications); spec 07 → v1.2; architecture → v1.7 (A-3, §6 job wording); database → v1.8 (D-8); overview §8.2 A-3 applied, D-8 added; CLAUDE.md §14 (P5-Q decisions) |
| Migrations (FK order) | `orders` (+ `order_number_seq`), `seller_orders`, `order_items`, `order_item_cancellations`, `order_status_history`, `seller_order_status_history`, `inventory_reservations`, `payments`, `payment_refunds`, `payment_events` |
| `pkg/payments` | `IPaymentGateway` (`createSession`, `getSession`, `verifyWebhookSignature`; no `abandonSession`, K-1), Kashier adapter (`fetch` + timeout, secrets redacted from errors), fake adapter |
| `app/inventory` | `InventoryReservationRepository`; `reserve` / `release` / `commit` (UC-IN-1…3), movements, `stock_status_changed` on reserve / release |
| `app/payments` | Module skeleton; repositories; `PaymentDirectory` (public API, spec 10 §2); webhook controller + service (UC-PA-1/2); `payments.order-adjustments` consumer (UC-PA-3); admin refunds (UC-PA-4); DTOs, errors, OpenAPI |
| `app/ordering` | Module skeleton; repositories; `CheckoutService`, `OrderStatusService` (derive + close, agent fee share), customer / seller / admin services and views; consumers `ordering.payment-updates`, `ordering.shipment-updates`; jobs `seller-acceptance-timeout`, `kashier-payment-expiry`; DTOs, errors, OpenAPI |
| Composition roots | api: payments + ordering modules and routers; worker: the three consumers, both jobs, the gateway |
| Tooling | Postman "Checkout & orders", "Seller: orders", "Admin: orders & payments" folders; `dev:kashier-webhook`; `.env.example` |

### 7.4 Tests
- **Unit:** checkout money (per-seller split, commission rounding, totals), partial-cancel recompute, the order status derivation (every rule in spec 09 §1.1), the agent fee share (equal split, remainder only to the closing delivery, S-13), refund / COD adjustment rules per event, the Kashier signature (known vectors from the docs), the fake gateway.
- **Integration, per endpoint** (CLAUDE.md §12): happy path, validation failure, authz failure (other roles; another customer's or seller's order → `404`), not-found. Plus:
  - checkout: COD and Kashier, two sellers → two seller orders; `CART_EMPTY`, `CART_HAS_ISSUES`, `GOVERNORATE_NOT_DELIVERABLE`, `ADDRESS_NOT_FOUND` (422), `ORDER_TOTAL_CHANGED`, `INSUFFICIENT_STOCK` with everything rolled back (no order, cart intact, stock unchanged); idempotent replay returns the same order; missing key `400`
  - concurrency: two customers checking out the last unit in parallel → one `201`, one `409`; the same checkout twice in parallel with one key → one order
  - Kashier: session failure → `checkoutUrl: null`, then `kashier-session` creates it; two parallel `kashier-session` calls → one stored session; webhook signed / unsigned / duplicate / unknown order / amount mismatch; paid → `order.placed`, seller orders `placed` with a deadline; expiry: unpaid → everything cancelled and stock released; provider says paid → not expired; webhook after expiry → `paid` + refund flag, order stays cancelled
  - seller flow: accept, ready (`seller_order.ready_for_pickup` payload), cancel, partial cancel (last open line → whole seller order cancelled, one event), return received; `pending_payment` orders invisible to sellers; the timeout job cancels only expired `placed` ones, and an accept racing the job → exactly one wins
  - shipment events (published by the test): picked up → out → delivered with `inventory.commit` and the fee share; failed / returning; events for a cancelled seller order ignored; duplicates are no-ops
  - close: all delivered / some / none (fee → 0, Kashier fee refund flag, COD final status)
  - admin: order list filters and detail with histories; refund queue; record a refund (partial → full status, `REFUND_ALREADY_RECORDED`)

### 7.5 Order of work (one commit each)
PR (a):
1. Docs: approvals applied (specs 07/09/10, architecture A-3, database D-8, overview, CLAUDE.md).
2. Migrations (all ten), with schema tests.
3. inventory: reservations, `reserve` / `release` / `commit`, tests.
4. payments: module skeleton, `PaymentDirectory` (`createForOrder`, `getSummaries`), COD side of `payments.order-adjustments`, tests.
5. ordering: COD checkout and order views, tests.
6. ordering: customer cancel, seller accept / ready / cancel / partial cancel / return received, timeout job, tests.
7. ordering: shipment consumer, delivered + fee share, close, tests.
8. Postman, `.env.example`, plan status.

PR (b):
9. `pkg/payments`: gateway interface, fake, Kashier adapter, tests.
10. payments: sessions, webhook, Kashier side of `payments.order-adjustments`, admin refunds, tests.
11. ordering: Kashier checkout, `kashier-session`, payment consumer, expiry job, tests.
12. Postman, `dev:kashier-webhook`, plan status.

### 7.6 Done when
- CI green; every P5 endpoint is in the OpenAPI document with its DTOs.
- Locally (docker-compose): a customer checks out a two-seller cart with COD → two seller orders `placed`, stock reserved, cart empty → one seller accepts and marks ready, the other cancels one item and then times out (short `SELLER_ACCEPT_TIMEOUT_HOURS` for the walkthrough) → stock released, order `in_progress`. A Kashier checkout paid through `dev:kashier-webhook` → `placed`; another left unpaid → cancelled after the TTL, stock released. Admin sees both orders, the payment and the refund queue.
- One manual run against the Kashier test environment (session → pay with a test card → signed webhook received) before staging.

**P5 status (2026-10-12): PR (a) implemented** on branch `p5-ordering-payments` (stacked on `p4-cart`; §7.5 steps 1–8). Locally green: lint, type-check, Prettier, unit (292), integration (348), build. Every PR (a) endpoint is in the OpenAPI document with its DTOs. Manual local walkthrough of the COD part of §7.6 **passed (2026-10-12)** on the docker-compose stack rebuilt from this branch (the 10 P5 migrations applied by `migrate`; the worker started `payments.order-adjustments`, `ordering.shipment-updates` and the `seller-acceptance-timeout` job): a fresh admin (seed-admin invite from Mailpit), the `seed:dev` demo seller and a walkthrough seller (passwords reset through Mailpit) and a newly registered customer with a Cairo address; the customer added variants of both sellers to the cart; the first checkout answered `409 ORDER_TOTAL_CHANGED` with the current total, the second placed `NM-000000001` (items 5448.00 + fee 50.00), and a repeat with the same Idempotency-Key replayed the same order; two `placed` seller orders with their commission snapshots and a 24 h deadline, both lines reserved, the cart empty, a pending COD payment of 5498.00 and `order.placed` dispatched; seller A saw its order without customer data and got `404` on seller B's, then accepted and marked it ready (`seller_order.ready_for_pickup` dispatched, order `in_progress`); seller B cancelled 1 of 2 units (`seller_order.items_cancelled`; the payments consumer lowered the COD amount to 2999.00); seller B's deadline was moved into the past (the 1 h minimum of `SELLER_ACCEPT_TIMEOUT_HOURS` rules out a short timeout) and the worker's job cancelled it on its next run (`seller_acceptance_timeout`, actor `system`), released the remaining unit (reservation `released`, quantity 0) and the COD amount fell to 500.00, equal to the order total; admin found the order by number and saw both histories; a customer on the admin list got `403`. No error, fatal or 5xx line and no password in any api/worker log line. The walkthrough found one bug: the order list counted the units of a whole cancelled seller order in `itemCount` (2 instead of 1), because only item cancellations set `cancelled_quantity`. Fixed the same day: `itemCount` counts only seller orders still billed (one `isBilled` rule shared with the OR-13 items total), with a regression test; the rebuilt stack then showed 1. Locally green after the fix: unit (292), integration (348). **Still to do for PR (a):** a green CI run on the PR. PR (b) (Kashier, steps 9–12) not started. Decisions taken during implementation (all approved, recorded in the specs and CLAUDE.md §14.1h): D-9 `inventory_reservations.quantity >= 0`, released ⇔ 0 (database v1.9); IN-6 `release` takes no reason and movement deltas are the change in sellable stock (spec 07 v1.3); OR-12 the last-units item cancellation reports the subtotal before it; OR-13 the order's `items_total` counts only seller orders neither cancelled nor returned (spec 09 v1.1); OR-14 early shipment events are retried, stale ones ignored (spec 09 v1.2). Deviations from §7.3–§7.5:
- Step 4 built the whole `payments.order-adjustments` consumer, Kashier refund rows included (planned for step 10), so it was tested in one go. Step 10 keeps the webhook, sessions and admin refunds.
- Step 5 also built the seller and admin order views (step 6 is the actions only). `POST /checkout` refuses `paymentMethod: kashier` with a 400 until step 11: without the session, webhook and expiry job, an unpaid Kashier order would hold its stock forever.
- The order write path after checkout is one shared service (`OrderLifecycleService`: lock, conditional transition + history, re-derive, close), used by the HTTP actions, the acceptance-timeout job and the shipment consumer.
- Env keys: api `SELLER_ACCEPT_TIMEOUT_HOURS`; worker `JOB_SELLER_ACCEPTANCE_TIMEOUT_INTERVAL_MS`, `ORDER_JOBS_BATCH_SIZE` (in `.env.example`, `dev-env.js` and the test env). Existing local `.env` files need `npm run dev:env` before the api and worker restart. The Kashier keys and `KASHIER_PAYMENT_TTL_MINUTES` come with PR (b).
- The worker now registers payments and the ordering core (consumers `payments.order-adjustments`, `ordering.shipment-updates`; job `seller-acceptance-timeout`).
- Test helpers: `test/helpers/order-fixtures.ts` (SQL fixtures for orders, seller orders, lines and payments) and `test/helpers/ordering-api.ts` (customers with addresses, listed variants, carts and COD checkouts over HTTP).
- Tooling: Postman collection regenerated (89 requests; new "Checkout & orders", "Seller: orders" and "Admin: orders" folders; Checkout stores the current total in `expectedTotal` on `ORDER_TOTAL_CHANGED`, then `orderId`, `sellerOrderId` and `orderItemId`).

**P5 status (2026-10-12): PR (b) implemented** on the same branch (§7.5 steps 9–12). Locally green: lint, type-check, Prettier, unit (326), integration (371), build. Every P5 endpoint is in the OpenAPI document. Kashier was verified against its **test environment** (2026-10-12, with the user's test account): session create (one open or paid session per `order`, also for parallel calls), the unauthenticated status read, and the compiled adapter's error classes; the documented abandon call answered 404 in every form. Manual local walkthrough of the Kashier part of §7.6 **passed (2026-10-12)** on the rebuilt docker-compose stack (fake gateway; the worker started `ordering.payment-updates` and the `kashier-payment-expiry` job): a Kashier checkout awaited payment for 15 min with a payment page (the same page again from `kashier-session`), was paid with `npm run dev:kashier-webhook` (a correctly signed webhook) and placed by the worker; a second one was left unpaid, its window moved into the past, and the job cancelled it within ~6 s (`payment_expired`, unit released, payment `expired`); a late payment on it became `paid` with one full `late_payment_after_expiry` refund and the order stayed cancelled; admin found it in the refund queue and recorded it (`refunded_manually`; recording again → `409 REFUND_ALREADY_RECORDED`). No error, fatal or 5xx line, and no password or Kashier key in any api/worker log line. **Still to do for P5:** green CI runs on both PRs, and one manual run against the Kashier test environment through a public tunnel (session → pay with a test card → Kashier's signed webhook received and verified) before staging; `KASHIER_REDIRECT_URL` to agree with the mobile team (OR-11) and the Kashier IP allow-list (K-7) before staging. Decisions taken during PR (b) (all approved, recorded in spec 10 v1.1–v1.3, spec 09 v1.3, architecture v1.8, CLAUDE.md §14.1h, §14.2): K-1…K-7 / PA-11…PA-17 from the test environment (no session abandon; `order` = payment id; status mapping with `PENDING` waiting a run; no FEP / payment-type env keys; dedupe id `<event>:<transactionId>`; secret key single-quoted; IP allow-list open for P8); PA-18 the worker holds no Kashier secret; PA-19 the webhook answers in the standard envelope; PA-20 flagged refunds never exceed the collected amount. Deviations from §7.3–§7.5:
- PA-20 is a bug fix found by the step 11 tests: a late payment's full refund (SD-5) plus the refunds of the expiry's own cancellation events, consumed afterwards, flagged the money twice.
- `createKashierSession` takes the session's description (`Nile order NM-…`) as well as its expiry; it returns a typed result (`session` / `not_awaiting_payment`) so payments needs no ordering error code.
- The webhook router is mounted before the global rate limit (spec 10 §4.1, architecture §10); the raw-body parser for its path already existed (P0).
- The fake gateway lives in each process: locally the worker's fake doesn't know the api's sessions and reports them unpaid, so local payments go through `dev:kashier-webhook`. Tests share one fake between the api and the worker.
- Env keys: api `PAYMENT_GATEWAY`, `KASHIER_*` (api-only: merchant id, secret key, redirect and webhook URLs), `KASHIER_PAYMENT_TTL_MINUTES`; worker `PAYMENT_GATEWAY`, `KASHIER_API_KEY`, `KASHIER_HTTP_TIMEOUT_MS`, `KASHIER_BASE_URL`, `KASHIER_MODE`, `SELLER_ACCEPT_TIMEOUT_HOURS`, `JOB_KASHIER_PAYMENT_EXPIRY_INTERVAL_MS`. Existing local `.env` files need `npm run dev:env`.
- Tooling: `npm run dev:kashier-webhook -- <orderId> [paid|failed] [amount]` (development only; signs with the compiled `pkg/payments`, so it needs `npm run build`); Postman collection regenerated (94 requests: `paymentMethod` variable for Checkout, "Kashier payment page", new "Admin: payments" folder).


---

## 8. Phase 6: delivery (agents, shipments, assignment)

Status: **v1.0 APPROVED (2026-10-12).** All P6-Q recommendations accepted; the branch `p6-delivery` is stacked on `p5-ordering-payments`.
Needs approved: spec `11-delivery.md` (v1.1 now), D-2, D-3 and D-10 (database v1.10), plus the P6-Q decisions below. It builds on P5: the `seller_order.*` events delivery consumes and the `shipment.*` contracts ordering already consumes (spec 09 OR-14) exist.

### 8.1 What P6 delivers, and what it can't yet
- **delivery:** agents created by admins (invited through identity), the availability toggle, shipments created from `seller_order.ready_for_pickup`, automatic assignment and its retry job, admin assignment / reassignment, the agent's work (picked up, out for delivery with the COD fee carrier, delivered with the cash check, failed attempts, returns), the `delivery.seller-order-updates` consumer, the agent / admin endpoints of spec 11 §4.2–§4.3, and the public API finance will call (`getAgentByUserId`, `getAgentSummaries`).
- **End to end:** with P5, an order now goes all the way: checkout → seller ready → shipment assigned → picked up → delivered → `seller_order.delivered` (fee share) → payments (COD collected) → close.
- **Not yet:** finance (P7) consumes `seller_order.delivered` / `order.closed` but books nothing until then.

### 8.2 Decisions to approve (P6-Q)

| # | Topic | Options / recommendation |
|---|---|---|
| P6-Q1 | Approvals and branch | **Rec:** approve the rest of spec 11 → v1.1 with the clarifications in P6-Q2…Q12 written into it; D-2 and D-3 plus D-10 (database v1.10). One branch `p6-delivery` stacked on `p5-ordering-payments`, one PR (the module is about the size of P4 + P3's projections) · or two PRs (agents + assignment, then the agent's work) |
| P6-Q2 | **D-2**: what the shipment snapshots | Delivery can't call ordering (architecture §2), so the shipment keeps what the agent's screen and the fee rules need, from the `seller_order.ready_for_pickup` payload: `order_number VARCHAR(20)`, `payment_method VARCHAR(20)` (CHECK), `order_delivery_fee money` (COD fee of the checkout, `0.00` for Kashier), `pickup_business_name VARCHAR(150)`, the full pickup and drop-off snapshots (incl. `dropoff_governorate_name`), and `cod_items_amount`. `agent_fee_share` is **dropped**: ordering computes it and the ledger records it (P5). **Rec:** approve D-2 as written in overview §8.2 |
| P6-Q3 | **D-3 / D-10**: indexes `02-database.md` §10 lacks | (a) **D-3** `idx_shipments_status_created_at_id (status, created_at DESC, id DESC)`: `GET /admin/shipments?status[…]`; (b) `idx_shipments_created_at_id (created_at DESC, id DESC)`: the unfiltered admin list (as D-8 a for orders); (c) `idx_shipments_agent_id_created_at_id (agent_id, created_at, id) WHERE agent_id IS NOT NULL`: the agent's list (default sort `createdAt` ascending), also with a delivered history of thousands; `idx_shipments_agent_id_status` stays for the active count; (d) `idx_shipments_status_created_at` replaces the `WHERE status = 'unassigned'` index with `(created_at, id)` for the retry job's keyset; (e) `idx_delivery_agents_created_at_id (created_at DESC, id DESC)` for `GET /admin/delivery-agents`; (f) FKs `ON DELETE RESTRICT`, no index on `shipments.seller_order_id`'s FK beyond its unique, none on `shipment_attempts.agent_id` (audit pointer). **Rec:** all of (a)–(f) |
| P6-Q4 | Deactivating an agent who never accepted the invite | Spec 11 UC-DE-6 calls `identity.setUserStatus(suspended)`, but identity only allows `active ⇄ suspended` (spec 03 I-6), so a still-`invited` agent can't be deactivated, and could accept the invite later and log in. **Rec:** (a) every agent endpoint except `GET /agent/profile` requires an **active** agent (`403 AGENT_INACTIVE`), so an inactive agent can do nothing whatever the login state; (b) deactivate suspends the login only when the user is `active` (S-10), and leaves an `invited` user alone; activate reactivates the login only when it is `suspended`. No change to identity · or amend spec 03 I-6 to allow `invited → suspended` for agents (a spec 03 change and a "resend invite after reactivation" flow) |
| P6-Q5 | A parcel picked up after its seller order was cancelled never finishes | UC-DE-5: such a shipment goes `returning_to_seller`, but ordering ignores the seller order (it is `cancelled`), so `seller_order.returned` never comes and the shipment stays open forever, counting against the agent. **Rec:** a column `seller_order_cancelled_at TIMESTAMPTZ NULL`; for those shipments the **agent** confirms the handover: `POST /agent/shipments/:id/returned` (only `returning_to_seller` with `seller_order_cancelled_at` set) → `returned_to_seller`. Normal returns still close on `seller_order.returned` (the seller confirms, Q-33) · or an admin endpoint closes them |
| P6-Q6 | Lock order inside delivery | **Rec:** shipments of one checkout by id → the shipment's agent → other agents. Assignment locks the shipment, then picks the agent with `FOR UPDATE SKIP LOCKED`; admin assign locks the shipment, then the target agent `FOR UPDATE`; deactivate / availability lock the agent and count its active shipments; the fee carrier locks every shipment of the checkout (`WHERE order_id = ? ORDER BY id FOR UPDATE`). Delivery never locks ordering's or payments' rows, and their consumers never lock shipments, so there is no cycle |
| P6-Q7 | COD fee carrier details (SD-2, DB-Q1) | **Rec:** (a) only COD shipments take part (Kashier shipments have `order_delivery_fee = 0.00` and `amountToCollect` `0.00`); (b) the carrier is chosen at `out-for-delivery` under the checkout's shipment locks, and released on a failed attempt or a late cancellation; (c) `shipment.delivered` carries `deliveryFeeCollected = carries_delivery_fee`, `deliveryFeeAmount = cod_fee_amount`, `codCollectedAmount = items + fee`; (d) `uq_shipments_order_id_fee_carrier` backs it, and a unique violation (two parallel outs of one checkout without the lock) can't happen under (b); the S-3 gap stays accepted |
| P6-Q8 | Event order for the delivery consumer | Same as OR-14: **Rec:** `seller_order.cancelled` / `items_cancelled` / `returned` for a seller order whose shipment doesn't exist yet but whose `previousStatus` (or state) says it should → retried (spec 11 UC-DE-5 already says so for `cancelled`); otherwise a stale event is a `warn` no-op. `seller_order.ready_for_pickup` is replay-safe (`ON CONFLICT (seller_order_id) DO NOTHING`) |
| P6-Q9 | The retry job | **Rec:** `shipment-assignment-retry` handles `unassigned` shipments oldest first, one short transaction per shipment (`FOR UPDATE SKIP LOCKED` on the shipment), same candidate rule as UC-DE-1; env `JOB_SHIPMENT_ASSIGNMENT_RETRY_INTERVAL_MS` (60 000) and `SHIPMENT_JOBS_BATCH_SIZE` (100), replacing spec 11's `SHIPMENT_ASSIGNMENT_RETRY_INTERVAL_SECONDS` to match the other job keys (`JOB_*_INTERVAL_MS`, P5-Q10) |
| P6-Q10 | Agent's list default | **Rec:** without a `status` filter, `GET /agent/shipments` returns the **active** statuses (spec 11 §4.2); `status[in]=delivered,returned_to_seller,cancelled` shows the history. Oldest first by `createdAt` (the order the agent works in) |
| P6-Q11 | Finance's public API | **Rec:** build `getAgentByUserId` and `getAgentSummaries` now and test them through the public API, so delivery is finished in one go (as P2-Q8) |
| P6-Q12 | Process split | **Rec:** api: agent and admin endpoints, the public API. Worker: the `delivery.seller-order-updates` consumer (creation + auto-assignment, cancellations, returns) and the retry job. Both use one `ShipmentAssignmentService` (the candidate query + assign) |

### 8.3 Scope

| Area | Content |
|---|---|
| Docs | Spec 11 → v1.1 (P6-Q clarifications); database → v1.10 (D-2, D-3, D-10); overview §8.2 D-2, D-3 applied, D-10 added; CLAUDE.md §14 (P6-Q decisions) |
| Migrations | `delivery_agents`, `shipments`, `shipment_attempts`, `shipment_status_history` (raw SQL, `02-database.md` §10 with D-2, D-3, D-10, P6-Q5's column) |
| `app/delivery` | Agent and shipment repositories; `AgentService` (admin create / update / activate / deactivate, availability, profile); `ShipmentAssignmentService` (candidate + assign, auto and admin); `ShipmentWorkService` (picked up, out for delivery + fee carrier, delivered + cash check, failed attempt, agent-confirmed return of a cancelled order); `SellerOrderUpdateService` (consumer); `AssignmentRetryJob`; views; DTOs, errors (spec 11 §6), OpenAPI; public API additions |
| Composition roots | api: agent + admin routers; worker: the consumer, the retry job |
| Tooling | Postman "Agent" and "Admin: delivery agents & shipments" folders; `.env.example`; `seed:dev` gains a demo agent in Cairo |

### 8.4 Tests
- **Unit:** the shipment state machine, the fee-carrier rules (first out takes it, released on failure / cancellation, Kashier never), the COD cash check, attempt counting (refused → return; 3rd attempt → return), candidate ordering.
- **Integration, per endpoint** (CLAUDE.md §12): happy path, validation, authz (other roles; another agent's shipment → `404`), not-found. Plus:
  - creation from `seller_order.ready_for_pickup` (replayed → one shipment) and auto-assignment: fewest active shipments, then longest idle; off-shift / inactive / other-governorate agents skipped; no candidate → `unassigned`, then the retry job assigns once an agent goes on shift
  - concurrency: N shipments created at once with M agents → no agent over-assigned beyond the fair order; two parallel outs of one checkout → exactly one fee carrier
  - the agent's work end to end with ordering's consumer: picked up → out → delivered (COD amount checked; Kashier with no amount) → seller order `delivered`, order closed, COD payment collected; failed attempts → return → seller confirms → `returned_to_seller` both sides; the fee moves to the next shipment after a failure
  - cancellations: before pickup → shipment `cancelled`; after pickup → `returning_to_seller` and the agent's confirmed return (P6-Q5); out-of-order cancel before creation → retried, then applied
  - admin: create agent (invite email), update, deactivate with / without active shipments, activate; an inactive (or never-activated) agent gets `403 AGENT_INACTIVE` on the work endpoints (P6-Q4); assign / reassign rules (S-18, Q-41)

### 8.5 Order of work (one commit each)
1. Docs: approvals applied (spec 11, database, overview, CLAUDE.md).
2. Migrations, with schema tests.
3. Agents: repositories, admin endpoints, availability, profile, public API, tests.
4. Shipments: creation consumer, assignment service, retry job, admin assign, tests.
5. Agent's work: picked up / out (fee carrier) / delivered / failed / return, tests (with ordering's consumer, end to end).
6. Cancellations and returns from the seller-order events, tests.
7. Postman, `.env.example`, `seed:dev` demo agent, plan status.

### 8.6 Done when
- CI green; every P6 endpoint is in the OpenAPI document with its DTOs.
- Locally (docker-compose): admin creates an agent in Cairo (invite from Mailpit) → the agent goes on shift → a customer checks out (COD) from a Cairo seller → the seller accepts and marks ready → the shipment is auto-assigned to the agent → picked up → out for delivery (amount to collect = items + fee) → delivered with that amount → the seller order is `delivered`, the order `completed`, the COD payment `collected`. A second order: one failed attempt, then refused → returning → the seller confirms the return → stock released, order closed without a fee.

**P6 status (2026-10-12): implemented** on branch `p6-delivery` (stacked on `p5-ordering-payments`; §8.5 steps 1–7). Locally green: lint, type-check, Prettier, unit (339), integration (407), build. Every P6 endpoint is in the OpenAPI document with its DTOs; Postman has the "Agent" and "Admin: delivery agents & shipments" folders (113 requests); `seed:dev` creates the demo agent `demo-agent@nile.test` in Cairo, active and on shift. Manual local walkthrough **passed (2026-10-12)** on the docker-compose stack rebuilt from this branch (5 P6 migrations applied by `migrate`), scripted against the API and Mailpit: an admin (`seed-admin` invite) created an agent in Cairo → invite email in Mailpit → the agent accepted it and went on shift (the `seed:dev` demo agent off shift for the run); agents left over from aborted runs were handled through the admin API (their assigned shipment reassigned, `assigned → assigned (admin, reassigned)`, then deactivated: `inactive`, login `suspended`). Order 1 (COD, 450.00 + 50.00 fee): accept → ready → the shipment was auto-assigned in 0.8 s → picked up (seller order `picked_up` in 1.1 s) → out for delivery with `amountToCollect` 500.00 → a wrong amount answered `422 COD_AMOUNT_MISMATCH` → delivered with 500.00 → seller order `delivered`, order `completed`, COD payment `collected` 500.00, stock 3 → 2. Order 2 (249.00 + 50.00): out with 299.00 → `customer_unreachable` → `delivery_failed`, fee released (249.00) → out again with 299.00 → `customer_refused` → `returning_to_seller` → the seller confirmed the return → shipment and seller order `returned_to_seller`, order `cancelled` with total and fee 0.00, payment `cancelled`, stock back to 12; the shipment history shows every step with its actor and reason; the agent ended with 0 active shipments. No `error`/`fatal` or 5xx line and no password or token in the api / worker logs. **Still to do for "done when":** a green CI run on the PR. Deviations and additions to §8.2–§8.5, all approved:
- **D-11** (database v1.11): a defect in the shared cursor pagination, found by the agent list (the first list sorted oldest first): the cursor carries a JS `Date` (ms) while the columns had µs, so ascending pages repeated their last row and descending ones could skip same-millisecond rows. Every cursor-sorted timestamp (10 columns) is now `TIMESTAMPTZ(3)`; rule in CLAUDE.md §6.2; regression test `list-cursor-precision`.
- **E-8 / OR-15 / DE-15** (events v1.1, ordering v1.4, delivery v1.2): `seller_order.items_cancelled` carries `previousStatus`, so an item cancellation that overtakes `ready_for_pickup` is retried instead of acked; the COD amount only goes down (an older event is a `warn` no-op).
- **DE-16** (delivery v1.2): `seller_order.returned` for a missing shipment is retried; returns and cancellations on a finished shipment are `warn` no-ops; the after-pickup cancellation locks the checkout's shipments (it releases the fee).
- The out-of-order cases are tested on the consumer service directly (the broker's retry path is covered by `lib/events`), because the test retry delays (100 / 200 ms) are too short to hold an event back reliably.

---

## 9. Phase 7: finance

Status: **v1.0 APPROVED (2026-10-13).** All P7-Q recommendations accepted; the branch `p7-finance` is stacked on `p6-delivery`.
Needs approved: spec `12-finance.md` v1.0 (the P7-Q clarifications are FI-1…FI-11), D-12 (database v1.12), plus the P7-Q decisions below. It builds on P5 and P6: `seller_order.delivered` and `order.closed` are already published with every amount the ledger needs (events §3.4), and the public APIs finance calls exist (`sellers.getSellerByUserId` / `getSummaries`, `delivery.getAgentByUserId` / `getAgentSummaries`, DE-11). No other module changes.

### 9.1 What P7 delivers, and what it can't yet
- **finance:** accounts and the append-only ledger, the `finance.ledger` consumer (spec 12 §1.2), admin COD remittances and payouts (§1.3), admin balance / statement / reference views, and the seller and agent read-only endpoints (S-14).
- **End to end:** with P5 and P6, a delivered seller order now ends in the ledger: seller earning, commission, agent fee share, COD cash held by the agent. The closed order books the platform's delivery revenue, and admins clear the cash and record payouts.
- **Not in R1:** automated payouts, refunds in the ledger (E-6), notifications on `cod.remittance_confirmed` / `payout.recorded` (no consumer).
- **No backfill:** nothing runs in production yet. The `finance.ledger` queue is declared when the worker first starts finance, so local orders delivered before P7 are never booked (local data only; the walkthrough uses new orders).

### 9.2 Decisions to approve (P7-Q)

| # | Topic | Options / recommendation |
|---|---|---|
| P7-Q1 | Approvals and branch | **Rec:** approve spec 12 → v1.0 with P7-Q2…Q12 written into it, and D-12 (database v1.12, P7-Q3). One branch `p7-finance` stacked on `p6-delivery`, one PR (smaller than P6: four tables, one consumer, read endpoints and two admin writes) |
| P7-Q2 | `platform_delivery_revenue` can stay negative | Spec 12 §1.1 says "briefly". With the accepted S-3 gap (spec 11 §1), a COD checkout can deliver seller orders whose agents earn their share while the fee is never collected. Rows 3/4 then debit the account with no row 6 credit, for good. **Rec:** spec 12 §1.1 says "Yes": briefly when events arrive out of order, and permanently by the agent shares of a checkout whose COD fee was never collected (S-3). That is the platform's real loss (the agents earned their share), and it matches the `COD_DELIVERY_FEE_UNCOLLECTED` log line · or withhold the agent shares when the fee wasn't collected (changes ordering's fee share rule, spec 09 §3.8, and Q-27) |
| P7-Q3 | **D-12**: schema gaps in `02-database.md` §11 | (a) every cursor-sorted timestamp is `TIMESTAMPTZ(3)` (D-11): `finance_accounts.updated_at`, `ledger_entries.created_at`, `cod_remittances.created_at`, `payouts.created_at`; (b) a DB guard for the non-negative accounts, `chk_finance_accounts_balance_non_negative CHECK (account_type = 'platform_delivery_revenue' OR balance >= 0)`, instead of "enforced in the app" only; (c) CHECKs for `account_type`, `direction`, `entry_type`, `payee_type`, and a new one for `reference_type` (`seller_order, order, cod_remittance, payout`), which §11 leaves unconstrained; (d) the admin account list sorts by `-balance` (default) or `updatedAt` with a cursor: `idx_finance_accounts_balance_id (balance DESC, id DESC)` and `idx_finance_accounts_updated_at_id (updated_at DESC, id DESC)` (CLAUDE.md §6.3; the table stays under ~10k rows, and the write cost is one small index per booking); (e) keyset tie-break `id` on `idx_cod_remittances_agent_id_created_at_id` and `idx_payouts_payee_type_payee_id_created_at_id` (as D-6); (f) the unfiltered admin lists sort every row by `-createdAt`: `idx_cod_remittances_created_at_id` and `idx_payouts_created_at_id (created_at DESC, id DESC)` (as D-8 a); (g) FKs `ON DELETE RESTRICT`: `ledger_entries.account_id`, `cod_remittances.agent_id` → `delivery_agents`, `confirmed_by_user_id` / `recorded_by_user_id` → `users`. `finance_accounts.owner_id` and `payouts.payee_id` are polymorphic (seller or agent) and have no FK (reason in a SQL comment); no index on the `*_by_user_id` FKs (audit pointers, as P6-Q3 f); (h) `ledger_entries.source_event_id` stays nullable (admin actions have no event); (i) P7-Q8's unique constraint. **Rec:** all of (a)–(i) |
| P7-Q4 | Locking accounts in one booking | Spec 12 §1.1 locks the accounts of a booking "sorted by account id", but a lazily created account has no id until it is inserted. **Rec:** one multi-row `INSERT … ON CONFLICT (account_type, owner_id) DO NOTHING` for every account the booking touches, then one `SELECT … WHERE (account_type, owner_id) IN (…) ORDER BY id FOR UPDATE`, then the entries (one multi-row insert) and one balance update per account. Finance locks only its own rows and calls no module inside the transaction, so it adds no cycle to OR-3 / P6-Q6. The platform accounts are locked by every delivery, a hot row; accepted at the scale targets (~0.25 bookings/s at peak, short transactions) |
| P7-Q5 | Booking details | **Rec:** (a) an entry is written only for an amount `> 0` (`amount CHECK (> 0)`), so a delivery with `agentFeeShare` `0.00` writes no rows 3/4; (b) rows 1–6 of one `seller_order.delivered` go in one transaction with its `processed_events` row, and a replay is a no-op (dedupe), never a second booking; (c) `order.closed` books row 7 only for Kashier with `deliveryFee > 0` (for COD the fee is booked when collected, row 6); any other `order.closed` is acked with nothing written; (d) amounts are taken from the payload as they are (ordering computed and rounded them, spec 09 §3.8) and parsed through `Money`; a payload that doesn't parse is a permanent failure (DLQ), like N-3 |
| P7-Q6 | Remittance for an agent with no COD account | Spec 12 lists `AGENT_NOT_FOUND` (FK) and `REMITTANCE_EXCEEDS_BALANCE`, but the balance check runs first, and an unknown agent has no account. **Rec:** read `delivery.getAgentSummaries([agentId])` before the transaction: unknown → `422 AGENT_NOT_FOUND`; known but no account, or `amount > balance` → `422 REMITTANCE_EXCEEDS_BALANCE`. The FK stays as the backstop (mapped to the same code). Inactive agents can remit (they may still hold cash) |
| P7-Q7 | Payout to an unknown payee | Spec 12 says "no account → `PAYOUT_EXCEEDS_BALANCE`", so a typo in `payeeId` reads as "not enough balance". **Rec:** resolve the payee first (`sellers.getSummaries` / `delivery.getAgentSummaries`): unknown → `422 PAYEE_NOT_FOUND` (new code); known without an account → `PAYOUT_EXCEEDS_BALANCE`. Any seller / agent status can be paid (a suspended seller or inactive agent is still owed money) · or keep the spec as written |
| P7-Q8 | The same transfer recorded twice | `Idempotency-Key` stops a retried request, but not an admin recording the same bank transfer again from a new form. **Rec:** `uq_payouts_payee_type_payee_id_external_reference` → `409 PAYOUT_ALREADY_RECORDED` (D-12 i). Remittances have no external reference and stay unconstrained · or no constraint (the admin checks the payee's statement) |
| P7-Q9 | Who may read the self-service endpoints | P6-Q4 blocks inactive agents from the delivery work endpoints, while seller order views accept any seller status. **Rec:** `/seller/finance/*` for a seller in **any** status and `/agent/finance/*` for an agent in **any** status. They are read-only views of the caller's own money, which a suspended seller or a deactivated agent still needs (balance owed, cash to hand in). No profile → `500` (P4-Q9 rule) |
| P7-Q10 | `paidAt` and `GET /admin/finance/entries` | (a) `paidAt` must be `<= now` from the `Clock` (no tolerance); a future value → `422 PAID_AT_IN_FUTURE`. (b) The reference lookup isn't paginated: one reference has at most 6 entries (a delivery), and 1 for an order, remittance or payout; `referenceType` is an `enum` of the four reference types. **Rec:** both as written |
| P7-Q11 | Process split and env | **Rec:** api: the finance endpoints (admin, seller, agent), including the two admin writes. Worker: the `finance.ledger` consumer only (it resolves no names, so it needs neither sellers nor delivery). No new env keys |
| P7-Q12 | Read models | **Rec:** (a) `ownerName` in the admin account list and detail comes from one batched `sellers.getSummaries` and one `delivery.getAgentSummaries` per page (no N+1); `null` for platform accounts and for an owner the lookup no longer returns (logged `warn`); (b) `GET /seller/finance/balance` returns `"0.00"` and `updatedAt: null` when no account exists yet, and `GET /agent/finance/balances` returns `"0.00"` for a missing account; (c) seller / agent statements and lists only ever filter by the caller's own account or id, so another payee's rows are unreachable (no id in the path) |

### 9.3 Scope

| Area | Content |
|---|---|
| Docs | Spec 12 → v1.0 (P7-Q clarifications; new codes `PAYEE_NOT_FOUND`, `PAYOUT_ALREADY_RECORDED`); database → v1.12 (D-12); overview §8.2 D-12 added, O-1 finance part applied; CLAUDE.md §14 (P7-Q decisions) |
| Migrations | `finance_accounts`, `ledger_entries`, `cod_remittances`, `payouts` (raw SQL, `02-database.md` §11 with D-12) |
| `app/finance` | Module skeleton (`index.ts` header: owned tables, may call sellers + delivery); repositories (accounts, entries, remittances, payouts); `LedgerService` (ensure and lock accounts sorted, post entries, update balances; the only writer of balances); `LedgerBookingService` (consumer, spec 12 §1.2); `RemittanceService`, `PayoutService` (§1.3, outbox events); `FinanceViewService` (admin / seller / agent reads, name lookups); DTOs, list whitelists, errors (spec 12 §6), OpenAPI |
| Composition roots | api: `registerFinanceModule` + `createFinanceRouter`; worker: `registerFinanceWorker` + the `finance.ledger` handlers |
| Tooling | Postman "Admin: finance", "Seller: finance" and "Agent: finance" folders (payout / remittance requests with `Idempotency-Key`); `.env.example` unchanged |

### 9.4 Tests
- **Unit:** the booking rules per row and condition (COD with / without the fee, Kashier, share `0.00`, `order.closed` per payment method and fee), the overview §5 example (fee 60, 3 seller orders, 1 cancelled → agents 14 + 14, delivery revenue 32), balance arithmetic and `balance_after`, the non-negative rule per account type.
- **Integration, per endpoint** (CLAUDE.md §12): happy path, validation, authz (other roles; a seller / agent sees only their own rows), not-found (`ACCOUNT_NOT_FOUND`). Plus:
  - consumer: `seller_order.delivered` COD and Kashier → the expected entries and balances; replayed → booked once; `order.closed` before the deliveries → delivery revenue dips below 0, then ends at fee − shares; the S-3 case ends negative (P7-Q2); malformed payload → DLQ
  - end to end with P5/P6 (agent endpoints, real consumers): COD checkout delivered → seller payable = net, commission booked, agent fee share and COD cash = items + fee; Kashier checkout delivered and closed → delivery revenue booked on close
  - remittance: within balance → `201`, balance down, `cod.remittance_confirmed` in the outbox; over balance / no account → `REMITTANCE_EXCEEDS_BALANCE`; unknown agent → `AGENT_NOT_FOUND`; missing key `400`; replay → same body
  - payout: seller and agent; over balance; unknown payee → `PAYEE_NOT_FOUND`; same external reference twice → `409 PAYOUT_ALREADY_RECORDED`; `paidAt` in the future → `422`
  - concurrency: two parallel payouts that together exceed the balance → one `201`, one `422`; a payout in parallel with a delivery booking on the same account → both applied, final balance exact, `balance_after` chain consistent
  - lists: filters, sorts and cursors on accounts (money sort on `balance`), statements and the two admin lists; the reference lookup

### 9.5 Order of work (one commit each)
1. Docs: approvals applied (spec 12, database, overview, CLAUDE.md).
2. Migrations, with schema tests.
3. Ledger core and the `finance.ledger` consumer (worker wiring), tests (incl. end to end with P6).
4. Admin: accounts, statements, reference lookup, remittances, payouts, tests.
5. Seller and agent self-service endpoints, tests.
6. Postman, plan status.

### 9.6 Done when
- CI green; every P7 endpoint is in the OpenAPI document with its DTOs.
- Locally (docker-compose): a COD order delivered by the demo agent (the P6 walkthrough flow) → the seller sees their net in `/seller/finance/balance`, the agent sees the fee share and the cash in `/agent/finance/balances`, and admin sees commission and delivery revenue → admin confirms a remittance of the full cash (agent COD cash `0.00`) and records a payout to the seller (seller balance `0.00`); a second payout over the balance → `422`. A Kashier order paid through `dev:kashier-webhook`, delivered and closed → delivery revenue booked on close. No `error` / `fatal` or 5xx line.

**P7 status (2026-10-13): implemented** on branch `p7-finance` (stacked on `p6-delivery`; §9.5 steps 1–6). Locally green: lint, type-check, Prettier, unit (358), integration (441), build. Every P7 endpoint is in the OpenAPI document with its DTOs; Postman has the "Admin: finance", "Seller: finance" and "Agent: finance" folders (127 requests). No new env keys; `seed:dev` unchanged. Manual local walkthrough **passed (2026-10-13)** on the docker-compose stack rebuilt from this branch (the 4 P7 migrations applied by `migrate`; the worker started `finance.ledger`), scripted against the API and Mailpit: the admin, the `seed:dev` demo seller and demo agent logged in through password resets, and a new customer with a Cairo address. COD order `NM-000000007` (249.00 + 50.00 fee) was auto-assigned to the demo agent and delivered with 299.00 → the delivery booked seller net 211.65 and commission 37.35 (the demo seller's 15% rate; together the items total), agent fee share 35.00 (credit, and the same debit on delivery revenue), COD cash 299.00 and the 50.00 fee → `/seller/finance/balance` 211.65, `/agent/finance/balances` 35.00 / 299.00, admin platform commission 37.35 and delivery revenue 15.00 (fee − share); the COD `order.closed` booked nothing. Admin confirmed a 299.00 remittance (agent COD cash 0.00, visible in `/agent/finance/remittances`) and a 211.65 payout to the seller (balance 0.00, visible in `/seller/finance/payouts`); a further 0.01 payout → `422 PAYOUT_EXCEEDS_BALANCE`. Kashier order `NM-000000008`, paid through `npm run dev:kashier-webhook`, was reassigned by the admin to the demo agent (another agent was on shift) and delivered with no amount → no cash booked, and `order.closed` booked the 50.00 fee: delivery revenue 15.00 → 30.00. No `error` / `fatal` or 5xx line and no password, token or OTP in the api / worker logs; the only rejected requests were the expected ones (the first checkout of each order `409 ORDER_TOTAL_CHANGED`, the over-balance payout, and three `429` from the strict auth limit, which the script waited out through `Retry-After`). **Still to do for "done when":** a green CI run on the PR. Deviations and additions to §9.2–§9.5:
- `paidAt` must carry a time and a time-zone offset (`2026-01-15` or a local `2026-01-15T10:00:00` → `400`), so a payout date is never read in the server's local time. Spec 12 only says "ISO date-time".
- An admin remittance or payout for a payee without an account runs in the transaction that creates the account at `0.00`; the "exceeds balance" error rolls it back, so no empty account is left behind (spec 12 FI-5, FI-6).
- A booking that would take a non-negative account below 0 raises an internal `InsufficientBalanceError` from the ledger service; the admin actions map it to their 422 codes, and from an event it can only be a bug, so the event is retried.

---

## 10. Phase 8: hardening and infrastructure as code

Status: **v1.0 APPROVED (2026-10-13), revised the same day: no AWS in P8.** All P8-Q recommendations accepted (architecture v1.9 §13.1, CLAUDE.md §14.1k), then the user moved the staging deploy out of P8: P8 delivers everything that needs no AWS account, and the load test runs locally as a baseline. Applying staging, the checks that need it and the load test at production sizes are **P9** (§1). Until the stack reaches `main` (P8-Q1), `p8-hardening` is stacked on `p7-finance` and moves onto `main` after the merge.
Needs approved: the P8-Q decisions below and architecture v1.9. No business behaviour changes, so no module spec changes; a defect found by the security review or the load test is fixed with a regression test, and a fix that changes behaviour goes through its spec first. P8 needs no AWS account, domain or production keys.

### 10.1 What P8 delivers, and what moves to P9
- **Security review** of the whole API and its dependencies, findings fixed.
- **Runtime readiness for AWS:** the RDS CA bundle in the image, broker version parity (RabbitMQ 4.2), image and IaC scanning in CI.
- **Terraform** in `infra/terraform/` (bootstrap root, shared modules, `envs/staging`, `envs/prod`), written and checked offline: `fmt`, `validate`, Trivy. No `plan` or `apply` (they need AWS credentials).
- **Pipelines** written: `infra.yml` runs the offline checks on PRs; `deploy.yml` is in the repository but switched off until P9.
- **Load test baseline:** k6 against the local docker-compose stack seeded toward the design horizon. It finds slow queries and tunes the P3-O1 search threshold and the P2 seller-list `like`; it is **not** proof of the production targets.
- **Runbooks** written for P9 and go-live: deploy and rollback, seed admin, secret and JWT key rotation, restore, scaling.
- **Moves to P9 (staging deploy):** the cost estimate and the first apply, secrets put in, the first deploy, the Kashier test payment, Mailjet, the walkthroughs on staging, the load test at production sizes against the targets, the restore drill and the rollback check (old P8-Q13 target part, P8-Q16).
- **Not in P8 or P9:** production goes live only after a separate go-live decision (P8-Q3); Release 2 features; a metrics or error-tracking service (SD-4).

### 10.2 Before P8 starts: CI and `main`
Facts (2026-10-13): GitHub shows **no workflow run ever** on `eslam94fathy/nile-marketplace2` and no pull request; `main` is still the P0 plan commit, so it has no `ci.yml`; the phase branches `p0-foundation` … `p7-finance` are stacked. Every phase's "done when" still waits for a green CI run. P8-Q1 settles how the stack reaches `main`.

### 10.3 Decisions (P8-Q, approved 2026-10-13)

| # | Topic | Decision |
|---|---|---|
| P8-Q1 | Getting the stack onto `main` with green CI | (a) check that Actions is enabled for the repository; (b) open one PR `p7-finance → main` (it contains P0–P7), get CI green on it and fix what CI finds on `p7-finance`; (c) merge it, so `main` = the whole stack; the per-phase PRs are then closed as merged-through. P8 branches start from `main` |
| P8-Q2 | **SD-3d** region | `eu-central-1` (Frankfurt). RDS PostgreSQL 18 and Amazon MQ RabbitMQ 4.2 are checked in that region with the AWS CLI before the first apply (P9); `me-central-1` (UAE) if a check fails |
| P8-Q3 | Environments | `envs/staging` and `envs/prod` written over the same modules in P8; **staging applied in P9**; production at a separate go-live step with its own approval |
| P8-Q4 | AWS accounts | Two accounts in one AWS Organization (staging, prod), created by the user before P9, with a bootstrap admin identity for the first apply |
| P8-Q5 | Terraform setup | Exact Terraform (≥ 1.10) and AWS provider versions pinned, lock file committed; S3 state per env with native S3 locking (`use_lockfile`), bucket versioned, encrypted, public access blocked; a `bootstrap` root (state bucket, GitHub OIDC provider, read-only `plan` role, `deploy` role scoped to the repo) applied once by hand in P9; our own small modules, no community modules |
| P8-Q6 | Network and **K-7** | One VPC per env over 2 AZs; public subnets hold only the ALB and NAT gateway(s); ECS tasks and data stores in private subnets reachable only from the app security group; staging 1 NAT, prod 1 per AZ; S3 gateway endpoint. **K-7 = allow-list the NAT Elastic IPs in Kashier** (done in P9) |
| P8-Q7 | Managed services and sizes | As architecture §13.1: RDS PG 18 (`db.t4g.small` / `db.m7g.large` Multi-AZ), Redis OSS 7.x (`cache.t4g.micro` / `cache.t4g.small`), Amazon MQ RabbitMQ 4.2 `mq.m7g.medium`, Fargate x86_64 (api 1 / 2–4 autoscaled, worker 1 / 2). The cost estimate is approved before the first apply (P9) |
| P8-Q8 | RabbitMQ version | 4.2 in AWS; docker-compose and the Testcontainers image move to `rabbitmq:4.2-management` |
| P8-Q9 | TLS to the data stores | The image ships the Amazon RDS global CA bundle (downloaded at build, pinned by SHA-256) and sets `NODE_EXTRA_CA_CERTS`; Redis through `rediss://` with the AUTH token; RabbitMQ through `amqps://`. Verified by the first staging deploy (P9) |
| P8-Q10 | Secrets and configuration | One Secrets Manager secret per sensitive key per env; Terraform generates the DB password and writes the connection URLs; JWT, Kashier and Mailjet keys put in by hand (P9); every non-secret env key explicit in the task definition |
| P8-Q11 | Domain, certificate and app links | `api.staging.<domain>` with an ACM certificate on the ALB, HTTP → HTTPS, `TRUST_PROXY_HOPS = 1`; docs on in staging only. The domain is a Terraform variable, so P8 needs none; the user provides it before P9. App links may be placeholders in staging, required for prod |
| P8-Q12 | Pipelines | `deploy.yml` (ECR image by git SHA → migrate task → rolling update of api and worker; a `production` job behind required reviewers) is **written in P8 and runs only when the repository variable `DEPLOY_ENABLED` is `true`**, set in P9; until then it also offers `workflow_dispatch` that fails fast without the variable. `infra.yml` on PRs touching `infra/`: `terraform fmt -check`, `init -backend=false`, `validate` and Trivy config scan per root, from a pinned `hashicorp/terraform` image; the `plan` job is added in P9 with the read-only role. All AWS access through OIDC |
| P8-Q13 | Load test | **k6** scripts in `test/load/` from the pinned `grafana/k6` image. **P8: a local baseline** on the docker-compose stack, seeded by `scripts/perf-seed.js` toward the design horizon (2k sellers, 100k products / 300k variants, 100k customers, 200k orders with ledger rows), with the CLAUDE.md §15 traffic mix. It reports p50 / p95 / p99 and errors per scenario, finds slow queries (`EXPLAIN` of the worst), and tunes `SEARCH_WORD_SIMILARITY_THRESHOLD` and the seller-list `like`. Report: `docs/perf/p8-load-baseline.md`, labelled as a laptop baseline. **P9:** the same scripts against staging at prod sizes, pass = 300 req/s for 10 min, p95 < 300 ms reads / < 500 ms checkout, < 0.1 % errors |
| P8-Q14 | Security review | Full review against the OWASP API Top 10 and CLAUDE.md §10, findings in `docs/security/p8-review.md`, each high or critical fixed with a regression test; Trivy in CI (image + Terraform), failing on high / critical; a one-off gitleaks scan of the git history |
| P8-Q15 | Alerting | Written as the Terraform `alarms` module (log retention 14 / 90 days; alarms on error / fatal logs, DLQ events, ALB 5xx, unhealthy targets, RDS CPU and storage → SNS email); live from P9. SD-4 stays |
| P8-Q16 | Checks on a running environment | **Move to P9:** the Kashier test payment, Mailjet from staging, the walkthroughs on staging, the PITR restore drill, the rollback check |
| P8-Q17 | Branches and PRs | `p8-hardening` in three PRs: (a) security review fixes + runtime readiness; (b) Terraform + pipelines (offline); (c) load-test baseline, tuning, runbooks |

### 10.4 Scope

| Area | Content |
|---|---|
| Docs | Architecture v1.9 (P9 timing noted); CLAUDE.md §14.1k; `docs/security/p8-review.md`; `docs/perf/p8-load-baseline.md`; `docs/runbooks/` (deploy and rollback, seed admin, secrets and JWT key rotation, restore, scaling), written for P9 |
| App / image | RDS CA bundle + `NODE_EXTRA_CA_CERTS`; RabbitMQ 4.2 in docker-compose and Testcontainers; security fixes; tuning from the baseline |
| CI | Trivy (image + IaC) in `ci.yml`; gitleaks (once, documented); `infra.yml` (offline checks); `deploy.yml` (gated off) |
| `infra/terraform` | `bootstrap/`, `modules/{network,alb,ecs-service,rds,elasticache,amazon-mq,secrets,ecr,alarms}`, `envs/staging`, `envs/prod`; every root passes `fmt`, `validate` and Trivy |
| Load test | `scripts/perf-seed.js`, `test/load/*.js` (k6), a compose override for the run |

### 10.5 Verification
- **CI:** green on every P8 PR, including Trivy (no high / critical) and the offline Terraform checks for every root.
- **Security:** each fixed finding has a regression test; the report lists every finding with its status.
- **Runtime readiness:** the full integration suite passes on RabbitMQ 4.2; the image contains the CA bundle with its pinned checksum, and a local run with `NODE_EXTRA_CA_CERTS` set still connects.
- **Terraform:** `validate` passes for `bootstrap`, `envs/staging` and `envs/prod`; a reviewer can read every resource in the modules (no community modules).
- **Load baseline:** the report gives the numbers per scenario, the slow queries found and what changed; re-run after each fix.

### 10.6 Order of work (one commit each, after P8-Q1)
PR (a):
1. Docs: approvals applied (architecture v1.9, CLAUDE.md, this section).
2. Security review: report, then fixes with regression tests (as many commits as findings need).
3. Runtime readiness: RDS CA bundle, RabbitMQ 4.2 parity, Trivy in CI, gitleaks run.

PR (b):
4. Terraform bootstrap root and modules (network, alb, ecs-service, rds, elasticache, amazon-mq, secrets, ecr, alarms).
5. `envs/staging`, `envs/prod`, `infra.yml` (offline), `deploy.yml` (gated off).

PR (c):
6. Perf seed and k6 scenarios; the local baseline; tuning; report.
7. Runbooks, plan status.

### 10.7 Done when
- CI green on `main` with every P8 PR merged.
- The security review has no open high or critical finding.
- The app, image and tests are ready for AWS (CA bundle, RabbitMQ 4.2); Trivy and the offline Terraform checks run in CI.
- `infra/terraform` describes staging and prod completely and passes every offline check; `deploy.yml` is ready to switch on.
- The local load baseline is written up, with its tuning applied.
- P9 can start as soon as the user provides the AWS accounts, a domain, the staging keys and approves the cost estimate.

**P8 status (2026-10-13): implemented** on branch `p8-hardening` (stacked on `p7-finance` until P8-Q1 brings the stack to `main`; §10.6 steps 1–7). Locally green: lint, type-check, Prettier, unit (381), integration (the full suite after each code change; 442 at step 2, plus the jobs and migrations suites after steps 6–7), build; Terraform `fmt`, `validate` of the three roots, `terraform test` (4) and Trivy config clean; actionlint and shellcheck clean. **Not done for "done when":** green CI on `main` (P8-Q1: the `p7-finance → main` PR and Actions still have to be set up by the user; no workflow has run on the repository yet). What P8 delivered:
- **Security review** (`docs/security/p8-review.md`): no high or critical finding; F-1 webhook signed fields (spec 10 PA-21), F-2 one open Kashier payment per customer (spec 09 OR-16), F-4 suspended users' tokens blocked through a Redis deny entry (spec 03 I-11, architecture v1.10), F-3, F-5…F-7 fixed; F-8 not a finding; F-9, F-10 recorded. Trivy (image and config) in CI; gitleaks over all 88 commits: no leak. The first image scan found 14 high / critical findings, all in the base image (npm's bundled packages, Debian `perl-base`); the runtime image now applies Debian security updates and carries no npm, corepack or yarn.
- **AWS readiness:** the image ships the RDS CA bundle (`NODE_EXTRA_CA_CERTS`, pinned checksum); RabbitMQ 4.2 in docker-compose and the tests (the full integration suite passed on it).
- **Terraform** (`infra/terraform/`, offline only): bootstrap root (state bucket with its own KMS key, GitHub OIDC, `plan` and `deploy` roles), nine modules plus `environment`, `envs/staging` and `envs/prod` with every setting explicit; `env-keys.json` checked against the zod schemas by a unit test and by `terraform test` with mocked providers. A bug found while writing it: the deploy role trusted a GitHub environment `prod` while the workflow uses `production` (fixed).
- **Pipelines:** `infra.yml` (offline checks), `deploy.yml` → `deploy-environment.yml` → `scripts/deploy/ecs-deploy.sh` (one image for both environments, migrate task, rolling update, readiness) and `rollback.yml` (by SHA, without migrations); all off until `DEPLOY_ENABLED` (production also `PRODUCTION_ENABLED`).
- **Load baseline** (`docs/perf/p8-load-baseline.md`): `npm run perf:seed` (design-horizon data, signed tokens) and k6 scenarios. Fixed: D-13 `idx_products_min_price_id` (database v1.13) and a worker crash on a failed database connection (job runner, regression test). Threshold 0.35 kept, seller-name filter needs no index. Open for P9: P9-O1 search is 93 % of database time, P9-O2 api capacity per task, P9-O3 overload answers 500 (CLAUDE.md §14.2). The 300 req/s target run could not complete on the laptop (it stalled the machine); the target check is a P9 task on staging.
- **Runbooks** (`docs/runbooks/`): deploy and rollback, secrets and key rotation, first admin, restore, scaling, maintenance; written ahead of P9 and to be corrected there. Writing them found that a rollback image cannot run the migrate task (Knex refuses missing migrations), hence `SKIP_MIGRATIONS` and `rollback.yml`.
