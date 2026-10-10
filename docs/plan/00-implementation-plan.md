# Implementation Plan (Release 1)

Status: **P0 v1.0 APPROVED (2026-10-08) and implemented. P1 (§3) v1.0 APPROVED (2026-10-08) and implemented (see the P1 status after §3.6). P2 (§4) v1.0 APPROVED (2026-10-09). P3 (§5) v1.0 APPROVED (2026-10-10).** Later phases are detailed when their specs are approved.
Inputs: `CLAUDE.md`, `docs/design/01-architecture.md` v1.4, `docs/design/02-database.md` v1.5, `docs/spec/01-api-conventions.md` v1.2, `docs/spec/02-events.md` v1.0. Module phases also need their module spec (03–13) approved.

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
| P8 | Hardening: load test against the targets, security review, Terraform (`infra/terraform`), staging deploy | SD-3d (region) |

P0–P3 are detailed below (§2–§5). P4–P8 get their own section when their specs are approved.

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
