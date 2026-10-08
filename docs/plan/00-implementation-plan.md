# Implementation Plan (Release 1)

Status: **v1.0 APPROVED (2026-10-08).** Phase 0 approved, with all P0-Q recommendations accepted. Later phases are detailed when their specs are approved.
Inputs: `CLAUDE.md`, `docs/design/01-architecture.md` v1.1, `docs/design/02-database.md` v1.1, `docs/spec/01-api-conventions.md` v1.0, `docs/spec/02-events.md` v1.0. Module phases also need their module spec (03–13) approved.

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

Only **P0** is detailed below. P1–P8 get their own section when their specs are approved.

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
