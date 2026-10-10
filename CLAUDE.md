# CLAUDE.md — Nile Marketplace (Modular Monolith)

Read this whole file before every task. These rules are binding. If a rule conflicts with a request, say so and ask; don't silently break the rule.

## 0. Working agreement

- **Never assume.** If a requirement, business rule, or technical choice is ambiguous or missing, stop and ask. List the options and give a recommendation. Unresolved items go in §14.2 "Still open" until the user settles them.
- **No code without an approved plan/spec.** Order of work: spec → system design → implementation plan → code. Don't scaffold anything ahead of its phase.
- **Reference implementation:** `../nile-store/user-product-service` (Express 5 + Knex + tsyringe + Redis + RabbitMQ outbox). Copy its *structure and patterns*. Don't copy its *defects* (see §13).
- Keep changes small and reviewable, and stick to the task.
- Report outcomes honestly. If tests, lint, or build fail, say so and include the output.

## 1. Stack (fixed)

| Concern | Choice |
|---|---|
| Language | TypeScript, `strict: true` (plus the flags in §11) |
| Runtime | Node.js 24 LTS |
| Package manager | npm (lockfile committed, `npm ci` in CI/Docker) |
| HTTP | Express 5 |
| DB | PostgreSQL 18 (local/CI/Docker images pinned to `postgres:18`) |
| Query builder / migrations | Knex (migrations written as **raw SQL** in `knex.raw`) |
| DI | tsyringe (class-based, constructor injection) |
| Env validation | zod (env only) |
| Request/response DTO validation | class-validator + class-transformer |
| Logger | Own custom structured logger behind an `ILogger` interface (§9.2) |
| Cache / rate-limit / idempotency store | Redis (ioredis) |
| Async messaging | Transactional outbox, then RabbitMQ (topic exchange, publisher confirms), drained by `worker.ts` |
| Tests | Vitest + Supertest + Testcontainers (Postgres, Redis, RabbitMQ) |
| API docs | OpenAPI 3 spec generated from the class-validator DTOs via `class-validator-jsonschema` + `openapi3-ts`, served at `/api/v1/docs` plus Swagger UI, both behind `API_DOCS_ENABLED` (off in production, P0-Q4) |
| Packaging / deploy | Docker (multi-stage build, non-root user, `node dist/server.js` / `node dist/worker.js`) on **AWS** (ECS Fargate, RDS, ElastiCache, Amazon MQ). Infrastructure as code: **Terraform** in `infra/terraform/` |
| Module system / dev runtime | CommonJS output (`module: NodeNext`). Dev: `tsc --watch` + `node --watch --env-file=.env`. Tests: Vitest + `unplugin-swc` (P0-Q2, P0-Q3) |
| Auth / rate limit / broker / jobs libraries | `jose` (JWT RS256) · `rate-limiter-flexible` · `amqplib` + `amqp-connection-manager` · own advisory-locked job runner (P0-Q5…Q8) |
| Clients | Mobile app (plus any other client) consuming the REST API |

New dependencies need a reason and user approval. Prefer well-maintained libraries with types included.

## 2. Architecture: modular monolith

One deployable, one database, **strongly isolated business modules**. Design every module as if it might later be extracted into its own service.

### 2.1 Folder structure (G27)

```
src/
  app/                      # business modules (bounded contexts)
    <module>/
      index.ts              # PUBLIC API of the module: the only file other modules may import
      routes.ts
      controller/           # HTTP only: parse → validate → call service → send response
      service/              # business logic, transactions, authorization rules
      repository/           # all SQL for this module's tables (G9)
      model/                # domain models / entities
      dto/                  # strict request/response DTOs (G28)
      enums.ts              # module enums
      constants.ts          # module constants
      errors.ts             # module error definitions (codes + factories)
      events.ts             # events this module publishes (names + payload types)
      __tests__/            # unit tests (integration tests live in /test)
    health/
  lib/                      # app-specific infrastructure & cross-cutting wiring
    config/                 # env schema (zod) and the typed `env` object
    db/                     # knex instance, ping, transaction helper
    di/                     # container + tokens
    logger/                 # logger instance + request context (AsyncLocalStorage)
    http/                   # status codes, response helpers, pagination, query language
    error/                  # AppError, error codes, global error handler
    middleware/             # correlation, auth guards, rate-limit, idempotency, cache
    events/                 # outbox repo, drain, in-process event bus
  pkg/                      # generic, framework-agnostic utilities. MUST NOT import from app/ or lib/
    time/                   # time conversion utilities (G2)
    cache/  messaging/  email/  hashing/  ...   # interfaces + adapters
  migrations/               # raw-SQL knex migrations
  server.ts                 # HTTP entrypoint
  worker.ts                 # background entrypoint (outbox drain, crons)
test/
  integration/              # real Postgres/Redis
  helpers/
infra/
  terraform/               # AWS infrastructure as code (envs/staging, envs/prod, modules/)
docs/
  spec/                    # business spec (source of truth for behaviour)
  design/                  # system design (architecture, database)
```

Dependency direction: `app → lib → pkg`. `pkg` never imports `lib` or `app`, and `lib` never imports a module's internals.

### 2.2 Module boundary rules

1. A module may import **only** another module's `index.ts` (its public service interface, public DTO/types, event types). Never import another module's `repository/`, `model/`, or internal files. Enforce this with ESLint `no-restricted-imports` / boundaries rules.
2. **Each module owns its tables.** Only that module's repositories read or write them. No SQL joins across module-owned tables. Fetch through the owning module's public API (batched, see §6.4).
3. Synchronous cross-module calls go through the public service interface, injected by DI token.
4. Side effects that don't need to be atomic with the caller (notifications, projections, stats) go through **domain events** written to the outbox inside the same transaction.
5. No circular module dependencies. If two modules need each other, the boundary is wrong, so raise it.
6. Shared kernel (truly shared types like `Money`, `Id`, pagination) lives in `lib/` or `pkg/`, never in a business module.

## 3. Layer responsibilities

- **routes.ts:** wiring only. Path, middlewares (auth, role, rate-limit, idempotency, validation), controller method.
- **controller:** no business logic and no DB access. Validates input into a DTO, calls one service method, and responds with the shared response helpers and `HTTP_STATUS` constants. Express 5 forwards rejected promises to the error handler, so don't write try/catch-next boilerplate.
- **service:** business rules, authorization (ownership checks), transaction boundaries, outbox events. Throws typed `AppError`s and never touches `req`/`res`.
- **repository:** the only place with Knex queries. It returns domain models, never raw rows. Every method accepts an optional `trx` and **must use it** for every query inside (`(trx ?? this.db)(...)`). Explicit column lists only.
- **model:** typed domain objects with behaviour where useful (for example `inventory.getSellableStock()`).
- **Classes + DI everywhere (G10).** Register every controller, service, and repository in the container with tokens from `lib/di/tokens.ts`. Use `@injectable()` (with the `@`). Infrastructure (db, cache, logger, broker, clock) is injected through interfaces so tests can replace it.

## 4. Configuration & secrets (G6, G7)

- All config comes from env, validated with a **zod schema at boot**. **No defaults** for any variable. If a required var is missing or invalid, log a fatal error naming the bad keys (never their values) and exit with a non-zero code.
- Parse and coerce once (`z.coerce.number().int().positive()`, URLs, enums). The rest of the code reads the typed `env` object and never `process.env`.
- Security parameters live in env/secret stores, never in code: hashing cost/rounds, JWT secrets/algorithms/TTLs, API keys, CORS origins, rate-limit thresholds.
- `.env` is never committed. Keep a `.env.example` with keys only and no values.
- Never log secrets, tokens, passwords, OTPs, full card/PII data, cookies, or `Authorization` headers.

## 5. Constants, enums, status codes (G5, G11)

- No magic strings or numbers in logic. Use enums/`as const` objects for roles, statuses, event names, cache-key prefixes, header names, table names, and error codes.
- `lib/http/status-codes.ts` exports `HTTP_STATUS` (e.g. `HTTP_STATUS.CREATED`). Every controller and error uses it, with no numeric literals.
- Every TS enum value used in the DB has a matching `CHECK (col IN (...))` constraint.
- Time values go through `pkg/time` (G2): `toMs(15, TimeUnit.MINUTE)`, `toSeconds(...)`, `addDuration(date, ...)`. No inline `60 * 60 * 1000`.

## 6. Database (G8, G12–G17, G20, G22, G24)

### 6.1 Migrations
- Knex migrations whose bodies are **raw SQL** (`knex.raw`). Every migration has a working `down`.
- One concern per migration. Never edit a migration that has already been applied; add a new one.
- Migrations must be safe for production. Use `CREATE INDEX CONCURRENTLY` on large/live tables (outside a transaction). Add columns in expand/contract steps, never a destructive change in one go.

### 6.2 Schema rules
- **No DB `DEFAULT`s on business columns (G13).** The app must pass every value explicitly, so a forgotten `price`/`stock`/`status` fails loudly with `NOT NULL` instead of silently getting a value. Defaults are allowed **only** on technical columns: `id`, `created_at`, `updated_at`.
- **Primary keys:** `UUID` v7 (time-ordered) on every table. Generated by Postgres 18 native `uuidv7()`: `id UUID PRIMARY KEY DEFAULT uuidv7()` (a technical-column default, allowed by D5).
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Repositories set `updated_at = now()` explicitly on every update.
- `NOT NULL` by default. A nullable column needs a reason.
- **Enums:** `VARCHAR(n)` + a named `CHECK (col IN (...))` constraint whose values match the TS enum. No Postgres `ENUM` types.
- **Money:** single currency **EGP** for now (all amounts are EGP; no currency column, and the API never accepts a currency from clients). Stored as `NUMERIC(12,2)` with `CHECK (col >= 0)` where applicable. Never a JS `number` for money math: all money arithmetic uses `decimal.js` (`Decimal`), wrapped in a shared `Money` value object in `lib/` (currency fixed to an `EGP` constant, so multi-currency can be added later without touching call sites). Amounts are serialised as strings in the API and DB layer, and rounding mode is explicit (`ROUND_HALF_UP` unless the spec says otherwise).
- **Single schema:** all tables live in `public`. Table ownership per module is by convention and is documented in each module's `index.ts` header and in the system design doc.
- **Cross-module FKs are allowed** (e.g. `orders.customer_id → customers.id`). Reads still go through the owning module (§2.2).
- **Deletion strategy is decided per entity** in the spec (soft delete via `deleted_at TIMESTAMPTZ NULL`, or hard delete). Soft-deleted tables use partial indexes `WHERE deleted_at IS NULL`, and their repositories filter deleted rows by default.
- **Realistic length limits (G16):** `VARCHAR(n)` with a deliberate `n` (e.g. email 254, phone E.164 16, names 100, slug 160, SKU 64). `TEXT` only for genuinely long free text, and then with a length `CHECK`.
- Timestamps are `TIMESTAMPTZ`, stored in UTC.
- Use `CHECK` constraints for invariants (`price >= 0`, `reserved_stock <= available_stock`, status whitelists).
- Every FK is explicit about `ON DELETE` behaviour (usually `RESTRICT`).
- **Naming conventions (G14):**
  - Tables: plural `snake_case` (`order_items`). Columns: `snake_case`.
  - Index: `idx_<table>_<col>[_<col>]`. Unique: `uq_<table>_<col>[_<col>]`.
  - FK: `fk_<table>_<col>`. Check: `chk_<table>_<rule>`. PK: `pk_<table>`.
- **Identity vs. roles (G12):** `users` holds authentication identity only. Role-specific data lives in its own table referencing the user (`customers.user_id → users.id`, and likewise for other actor types). Exact actors: see the business spec.

### 6.3 Indexing (G17)
- Every index is justified by a **documented read query pattern**. Note the query in a SQL comment above the index.
- Composite index column order follows equality columns first, then range/sort columns. Partial indexes for hot subsets (`WHERE deleted_at IS NULL`, `WHERE dispatched_at IS NULL`). Use a covering `INCLUDE` when it pays off.
- Index every FK column that is used in joins or lookups.
- Don't duplicate an index already implied by a `PRIMARY KEY`/`UNIQUE` constraint.
- Cursor pagination needs an index matching `(sort_col, id)`.

### 6.4 Query rules
- **Never `SELECT *` (G24)**, including `returning('*')`. Repositories declare their column lists.
- **No N+1 (G20).** Load related data with a single `WHERE id = ANY(?)`/`whereIn` batch or a join *within the module*, then map in memory. Cross-module lookups use batched public methods (`getByIds(ids)`).
- **Existence checks use `EXISTS` (G22):** `select exists(select 1 from ... where ...)`. Never fetch a row just to see whether it exists.
- Uniqueness is enforced by DB constraints. App-level pre-checks are only for friendly errors, and the repository still maps a unique-violation (`23505`) to a domain error, because check-then-insert races.
- Concurrency-sensitive updates (stock, balances, status transitions) use **conditional atomic updates** (`UPDATE ... SET reserved = reserved + ? WHERE id = ? AND available - reserved >= ? RETURNING ...`) or `SELECT ... FOR UPDATE` inside a transaction. Never read-then-write without a lock.
- Keep transactions short. No network calls (HTTP, email, broker) inside a DB transaction. Use the outbox.
- Bulk inserts are one multi-row insert, not a loop of inserts.
- Parameterised queries only. Never interpolate user input into `knex.raw`. Sort/filter columns come from a whitelist map (§8).
- Set `statement_timeout` and pool limits from env. Expose `db.ping()` (`SELECT 1`) for health checks (G8).

## 7. HTTP API conventions

- Base path `/api/v1`. Resource-oriented, plural nouns, kebab-case paths.
- **Strict DTOs (G28):** every body, query, and params object is a class-validator DTO class, validated through one shared `validate` helper with `whitelist: true`, `forbidNonWhitelisted: true` (unknown keys → `400`, not silently stripped), `forbidUnknownValues: true`, and `plainToInstance(..., { enableImplicitConversion: false })` (use explicit `@Type`). Every field has type, length, range, and format decorators that match the DB limits. Nested objects use `@ValidateNested` + `@Type`, and arrays use `@ArrayMaxSize`. Validation errors come back as structured `details: [{ field, constraint, message }]`.
- Response DTOs are explicit too: never return a raw model/row (no `password_hash` leaks).
- Every endpoint's DTOs appear in the generated OpenAPI spec. An endpoint isn't done until its docs are complete.
- Uniform response envelope (`lib/http/response.ts`):
  - success: `{ "success": true, "data": ..., "meta"?: ... }`
  - error: `{ "success": false, "error": { "code": "PRODUCT_NOT_FOUND", "message": "...", "details"?: [...] }, "correlationId": "..." }`
- Use correct status codes from `HTTP_STATUS`. `201` for creates, `200` for reads/updates, `204` for deletes with no body. Don't reply `202` unless the work is actually async.
- Set `express.json({ limit })` from env, plus `app.disable('x-powered-by')`, `helmet`, a CORS allow-list from env, and the `trust proxy` setting from env (needed for correct client IP in rate limiting).

## 8. Pagination & list query language (G23)

- One reusable implementation in `lib/http/pagination` + `lib/http/query`.
- **Cursor (keyset) pagination** by default: `?limit=20&cursor=<opaque>&sort=-createdAt`. The cursor is an opaque base64url of `(sortValue, id)`, so ordering is always unique and stable (tie-break on `id`). `limit` has an env-configured default and max, and invalid values are rejected rather than coerced to NaN.
- Filter syntax: `?createdAt[gte]=2025-01-15&status[in]=active,pending&price[lte]=100`.
  - Operators: `eq, ne, gt, gte, lt, lte, in, like` (`like` only on whitelisted text fields).
  - Each list endpoint declares a **whitelist map**: `apiField → { column, type, allowedOps }`. Values are validated/coerced by `type` (date, number, uuid, enum). Unknown fields or operators → `400`.
- Response `meta`: `{ nextCursor, hasMore, limit }`.

## 9. Errors & logging (G1, G4, G26)

### 9.1 Errors
- `AppError` carries `code` (from an error-code enum), `message`, `httpStatus`, optional `details`, and an `isOperational` flag. Create errors with **factory functions** (`productNotFound(id)`), never shared singleton instances (those capture a stale stack trace and shared state).
- The global error handler maps known errors to the envelope, converts validation errors to `400`, maps PG errors (`23505` → `409`, `23503` → `409`/`422`, `23001` restrict violation → `409`, `23514` → `422`), and treats everything else as `500` with a generic message. Stack traces are never sent to clients in production.
- `process.on('unhandledRejection' | 'uncaughtException')` logs at `fatal` and shuts down gracefully.

### 9.2 Logging
- **Own custom logger** (`lib/logger`), implementing `ILogger` (`fatal/error/warn/info/debug` + `child(bindings)`), writing JSON to stdout (Docker collects it). It must provide: level filtering from env, ISO-8601 timestamps, automatic `correlationId` from AsyncLocalStorage, a redaction list for sensitive keys, `Error` serialisation (name/message/code/stack/cause), and safe serialisation (no crash on circular refs or BigInt).
- Structured JSON, one event per line, via an injected `ILogger`. No `console.*` in application code (the logger's own stdout writer is the only exception). No emojis. No free-form string concatenation: put data in fields.
- Every log line has: `level`, `timestamp` (ISO-8601 UTC), `message`, `service`, `env`, `correlationId` (when in a request/job context), and relevant metadata (`module`, `userId`, entity ids, `durationMs`).
- Levels: `fatal`, `error` (unexpected/5xx), `warn` (handled anomalies, 4xx worth noticing), `info` (lifecycle and business events), `debug` (dev only). The log level comes from env.
- Error logs include `error.name`, `error.message`, `error.code`, `error.stack`, `error.cause`, plus request context: `method`, route template, `statusCode`, `correlationId`, `userId`, `ip`. **Never** log raw bodies, headers, or cookies. Use a redaction list.
- Request logging: one completion log per request with method, route, status, and duration.
- **Correlation ID (G26):** middleware accepts an incoming `X-Correlation-Id` (validated UUID) or generates one, echoes the **same** value in the response header, stores it in `AsyncLocalStorage` so every log line picks it up automatically, and copies it into outbox event metadata so async consumers continue the trace.

## 10. Security

- **AuthN:** short-lived access JWT + rotating refresh token. Store refresh tokens hashed server-side so they can be revoked, and detect reuse (a reused refresh token revokes the whole token family). Pin the JWT algorithm on verify, and validate `exp`/`iss`/`aud`. **Transport for all clients:** access token in `Authorization: Bearer <token>`, and the refresh token sent in the request body to the refresh endpoint. No auth cookies (so no CSRF surface). Clients store tokens in secure storage (Keychain/Keystore).
- Passwords are hashed with **bcrypt**. The cost factor comes from env (G7) and is never hardcoded. Enforce bcrypt's 72-byte input limit via DTO max length. Compare in constant time. Return a generic message for wrong credentials, and avoid user enumeration on login/forgot-password.
- **AuthZ:** role guards at the route, plus **ownership checks in the service** (to prevent IDOR, e.g. a seller may only edit their own products). Deny by default.
- **Rate limiting (G18):** Redis-backed, keyed by IP plus account identifier where relevant. Strict limits on login, register, OTP/forgot/reset password, refresh, and payment endpoints, and a general limit on all others. Limits come from env. Return `429` with `Retry-After`.
- **Idempotency (G25):** state-changing endpoints that must not run twice (order placement, payments, any `POST` with money or stock effects) **require** an `Idempotency-Key` header. Store `key + user scope + request fingerprint (hash of method, route, body)`. Use an atomic "in-progress" lock (`SET NX`) to block concurrent duplicates (`409`), replay the stored status code and body for completed ones, reject a key reused with a different payload (`422`), and set a TTL from env. Consumers of async events are idempotent too (dedupe on `eventId`).
- Input validation on every boundary. Output encoding is handled by JSON. Parameterised SQL only.
- Run dependency auditing (`npm audit` / equivalent) in CI. Keep the lockfile committed.

## 11. Code style

- TS flags: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`, `experimentalDecorators`, `emitDecoratorMetadata` (needed by tsyringe and class-validator). `import "reflect-metadata"` happens once, first, in each entrypoint and the test setup.
- No `any`. Use `unknown` and narrow it. No non-null `!` to silence the compiler on data that can actually be missing (the definite-assignment `!` on DTO class fields is the only exception).
- ESLint (typescript-eslint, `no-floating-promises`, `no-misused-promises`, import boundaries) and Prettier, both enforced in CI.
- Naming: files `kebab-case.<layer>.ts` (`product.service.ts`), classes `PascalCase`, variables/functions `camelCase`, constants `UPPER_SNAKE_CASE`, DB `snake_case`. Map between camelCase and snake_case **only** in repositories.
- Functions do one thing. Prefer early returns. Comments explain *why*, not *what*.
- Inject `Date`/`now` through a `Clock` so time is testable.
- Graceful shutdown: stop accepting connections, drain in-flight requests within a timeout from env, then close DB, Redis, and the broker, and exit.

## 12. Health, testing, CI (G3, G29, G30)

- **Health:** `GET /health/live` (process up, no dependency checks) and `GET /health/ready`, which checks **every dependency** (Postgres ping, Redis ping, broker connection) with per-check timeouts and returns `200`/`503` with a per-dependency status. Never expose versions or secrets.
- **Tests (Vitest):**
  - Unit: services and pure logic, with repositories/infrastructure mocked through DI (child containers per test).
  - Integration: Supertest HTTP → DB against **real Postgres, Redis, and RabbitMQ via Testcontainers**, migrations applied, data isolated per test. Cover auth, validation, pagination/filters, idempotency, rate limits, concurrency (e.g. two parallel stock reservations), and the error envelope.
  - Every bug fix comes with a regression test. Every new endpoint comes with integration tests for its happy path, validation failure, authz failure, and not-found.
- **CI** (GitHub Actions, `.github/workflows/ci.yml`, on every PR and push to main): `npm ci` → lint → type-check → unit tests → integration tests → build → Docker image build → `npm audit`. A red CI blocks merge.
- **Docker:** multi-stage build (deps → build → slim runtime), non-root user, no dev dependencies or `.env` in the image, `HEALTHCHECK` wired to `/health/live`, and a `docker-compose.yml` for local Postgres/Redis/RabbitMQ. API and worker are separate containers built from the same image.

## 13. Reference service: patterns to keep vs. defects to avoid

**Keep:** the `app/lib/pkg` split, controller/service/repository/model/dto per module, class-validator DTOs + a shared validate helper (made stricter, §7), the custom JSON logger idea (fixed, §9.2), tsyringe tokens, zod env, explicit column lists, a `trx` param in repositories, transactional outbox + worker with `FOR UPDATE SKIP LOCKED`, the cache/email/broker interfaces in `pkg`, raw-SQL migrations, the `pkg` time utils.

**Do NOT replicate:**
- env defaults (`z.string().default(...)`) and reading `process.env` directly after parsing
- the correlation middleware generating *two different* UUIDs (request vs. response header) and logs that don't carry the id
- logger timestamps as epoch numbers, `console.error` in adapters, the error handler logging `req.body`
- shared singleton `AppError` instances, hardcoded `400` for conflicts, status code `202` for synchronous ops
- `injectable()` without `@`, and repository methods that ignore the passed `trx` (`db.raw` inside a `trx` update, `deleteByProductId` called without `trx`)
- check-then-update stock reservation (race condition), and `UPDATE ... RETURNING` without checking for zero affected rows
- `parsePaginationQuery` producing `NaN` limit, filters using raw client field names as columns, cursors on non-unique columns
- `TIMESTAMP` without time zone, DB `DEFAULT`s on business columns, unnamed FK constraints, redundant indexes on `UNIQUE` columns
- hardcoded bcrypt rounds, and an idempotency middleware with no lock, no fingerprint, and no status-code replay
- a health check that covers only the DB, and `"start": "node dist/server.ts"`

## 14. Decisions log & open decisions

### 14.1 Decided (2026-10-07)
D1 Node 24 LTS · D2 class-validator DTOs · D3 own custom logger · D4 Vitest · D5 DB defaults allowed only on technical columns (`id`, `created_at`, `updated_at`) · D6 UUID v7 PKs · D7 `NUMERIC(12,2)`, single currency EGP (O4) · D8 `VARCHAR + CHECK` enums · D9 clients include a mobile app · D10 bcrypt · D11 RabbitMQ · D12 cross-module FKs allowed · D13 single `public` schema · D14 deletion strategy per entity · D15 npm · D16 OpenAPI yes · D17 Docker · O1 Bearer tokens for all clients · O3 `decimal.js` · O6 `class-validator-jsonschema` + `openapi3-ts` · O2 Postgres 18 · O5 GitHub Actions

### 14.1b Decided (2026-10-08, Phase 0 plan)
P0-Q1 Node 24 locally via nvm (`.nvmrc`, `engines`, `engine-strict`) · P0-Q2 CommonJS output · P0-Q3 dev = `tsc --watch` + `node --watch`, tests = Vitest + `unplugin-swc` (decorator metadata), every constructor param uses `@inject(TOKEN)` · P0-Q4 API docs behind `API_DOCS_ENABLED`, off in production · P0-Q5 `jose` · P0-Q6 `rate-limiter-flexible` · P0-Q7 `amqplib` + `amqp-connection-manager` · P0-Q8 own advisory-locked interval job runner · P0-Q9 test DB per test file from a migrated template, Redis prefix and RabbitMQ vhost per file · P0-Q10 git, `main` branch · P0-Q11 dependency list in `docs/plan/00-implementation-plan.md` §2.3

### 14.1c Decided (2026-10-08, Phase 1 plan)
P1-Q1 env schema split per process (JWT private key api-only, email keys worker-only) · P1-Q2 `EMAIL_PROVIDER` mailjet | mailpit (Mailpit for local dev, in-memory sender in tests) · P1-Q3 `bcrypt@6.0.0` · P1-Q4 bcrypt cost 12, OTP 10 min / 5 attempts / 60 s cooldown, invite 72 h, access 15 min, refresh 30 days · P1-Q5 `JWT_PRIVATE_KEY` + `JWT_ACTIVE_KID` with documented rotation · P1-Q6 invite link = https app link via `INVITE_URL_BASE` (value agreed with the mobile team before staging) · P1-Q7 `seed-admin` CLI · P1-Q8 Mailjet account and verified sender available

### 14.1d Decided (2026-10-08, Phase 1 implementation)
P1-I1 passwords never trimmed; `opt` = shared `Optional()` (absent ok, `null` rejected) (spec 01 v1.1) · P1-I2 identity clarifications I-1…I-9: reset needs an active account, row lock on resend/forgot cooldown, bcrypt outside transactions, admin suspend only for customers/admins and only `active ⇄ suspended`, suspend reason in the audit log only, change-password limit keyed on IP + account email (spec 03 v1.1 §7.1) · P1-I3 notifications clarifications N-1…N-5: provider call outside the transaction, secrets redacted from provider errors, malformed payloads → DLQ, only 400/422 permanent (spec 13 v1.1 §7.1) · P1-I4 consumers with external effects use the host's `beforeTransaction` step (architecture v1.2 §3.2) · P1-I5 `notification_log` FK `ON DELETE SET NULL` + `chk_notification_log_error_on_failure` (database v1.3) · DB-Q6 `idx_users_role_created_at (role, created_at DESC, id DESC)` for admin lists, built concurrently (database v1.4)

### 14.1e Decided (2026-10-09, Phase 2 plan)
P2-Q1 specs 04, 05 v1.0, spec 11 v1.0 for the reference-data part only, A-2 applied (architecture v1.3) · P2-Q2 `identity.hashPassword` before the transaction, `createPendingUser(passwordHash)` (spec 03 v1.3, I-10) · P2-Q3 governorate names in English, app localizes by `code` · P2-Q4 governorates seeded with `delivery_fee = NULL`, sample fees via a dev-only seed · P2-Q5 governorates cache `v1:delivery:governorates`, `GOVERNORATES_CACHE_TTL_SECONDS` 3600, deleted after commit on fee change · P2-Q6 address writes lock the customer row; a new address becomes default whenever there is no live default · P2-Q7 `GOVERNORATE_NOT_FOUND` is a common `lib/error` code (spec 01 v1.2) · P2-Q8 full public APIs of customers, sellers and delivery reference data built in P2 · branch `p2-customers-sellers` stacked on `p1-identity`

### 14.1f Decided (2026-10-10, Phase 3 plan)
P3-Q1 specs 06, 07 v1.0, spec 05 v1.1, database v1.5, architecture v1.4 · P3-Q2 `inventory_reservations` + reserve/release/commit move to P5 · P3-Q3 product/variant writes lock the product row, category writes lock the category row · P3-Q4 seller guard reads `FOR SHARE` in the write transaction · P3-Q5 `attr.*` same-variant, needs `categoryId` · P3-Q6 generic list-query extensions, relevance rounded to 6 decimals in the cursor · P3-Q7 public "newest" on `published_at` (D-5) · P3-Q8 stock-history index with `id` (D-6) · P3-Q9 `CATEGORY_TREE_CACHE_TTL_SECONDS` 3600, `PRODUCT_DETAIL_CACHE_TTL_SECONDS` 60 · P3-Q10 only `adjust` (and P5 reserve/release) emits `inventory.stock_status_changed` · P3-Q11 / P2-O1 `23001` → `409`, catalog FK registrations · P3-Q12 slug fallbacks, `CATEGORY_SLUG_REQUIRED`, `seed:dev` sample catalog · branch `p3-catalog-inventory` stacked on `p2-customers-sellers` · D-7 `idx_products_category_id` for category usage checks (database v1.6) · CA-13 an active category always has an active parent, else `409 CATEGORY_PARENT_INACTIVE` (spec 06 v1.1) · product writes hold their category `FOR SHARE` (spec 06 v1.2, CA-2) · the product-detail cache holds no visibility or stock, so the projection consumers invalidate nothing and the worker has no Redis (spec 06 v1.3, CA-8)

### 14.2 Still open

| # | Topic | Options / recommendation |
|---|---|---|
| SD-3d | AWS region | Rec `eu-central-1`; see `docs/design/01-architecture.md` §12.2 |
| P3-O1 | Typo search misses multi-word names | Found 2026-10-10 in the P3 local walkthrough. Spec 06 UC-CA-6 uses `name % q` (pg_trgm `similarity` of the whole name, default threshold 0.3): "trial runer" vs "Trail Runner …" scores 0.28, "erbuds" vs "Wireless Earbuds" 0.263, so neither is found; typos in short names are. **Rec:** match on words, `q <% name` (`word_similarity`, same GIN index), with the threshold from a new env key set per search query (`SET LOCAL pg_trgm.word_similarity_threshold`), starting at 0.35 (the two examples score 0.389 and 0.571), and `word_similarity` in the relevance score; tune with real product names in P8 · or lower the `%` threshold · or keep the spec as is |

New ones go here as rows of this table.

When a decision is made, move it into the relevant section and into 14.1.

## 15. Business context (confirmed by the user, 2026-10-07)

- **Type:** multi-vendor marketplace. Platform earns a **commission per sale**, configured **per seller** (default **10%** when not set for a seller). Sellers must be **approved** before they can sell.
- **Clients:** mobile app (consumes the REST API).
- **Actors (final):** customer, seller, admin, delivery agent. (No moderator role.) **One role per account.** The same person needs separate accounts to act in two roles.
- **Orders:** a customer order containing items from several sellers is **split per seller** (one sub-order per seller).
- **Cancellation of an online-paid order (R1):** allowed. An admin refunds manually in the Kashier dashboard, and the system records the payment as `refunded_manually`. Automated refunds come in R2.
- **Payments:** Cash on Delivery (COD) and Kashier (kashier.io, online gateway). **COD money flow:** delivery agent collects cash → remits to platform → platform pays the seller (minus commission).
- **Inventory:** sellers manage their own stock. Products have **variants**, each with its own SKU and stock.
- **Delivery:** in-house delivery agents.
- **Release 1:** catalog (categories, products, variants, attributes) · search & filters · cart, checkout, orders · payments, shipping/delivery · **minimal admin API** (seller approval, categories, per-seller commission) · **minimal transactional messages** (password reset / OTP).
- **Scale targets (proposed by Claude 2026-10-07; user delegated the numbers, pending their review):** ~100k users and ~2k sellers in year 1 (design horizon 500k users) · ~100k products / ~300k variants · ~5k orders/day average, ~20k/day campaign peak · ~50 req/s average, ~300 req/s peak, read:write ≈ 20:1 · p95 latency < 300 ms reads, < 500 ms checkout · 99.9% availability.
- **Release 2:** reviews & ratings, wishlist · coupons/promotions, returns & refunds · notifications (email/SMS) · full admin back-office.

Full business rules live in the spec: `docs/spec/` (`00-overview.md` + one file per module). System design lives in `docs/design/` (`01-architecture.md`, `02-database.md`); code must follow it. The spec is the source of truth for business behaviour; this file is the source of truth for engineering rules. Everything not listed here is undecided.

## 16. Guideline traceability (from `guidelines.txt`)

G1 §9.2 · G2 §5 · G3 §12 · G4 §9 · G5 §5 · G6 §4 · G7 §4, §10 · G8 §6.4 · G9 §3 · G10 §3 · G11 §5 · G12 §6.2 · G13 §6.2 · G14 §6.2 · G15 §6.1 · G16 §6.2 · G17 §6.3 · G18 §10 · G20 §6.4 · G22 §6.4 · G23 §8 · G24 §6.4 · G25 §10 · G26 §9.2 · G27 §2.1 · G28 §7 · G29 §12 · G30 §12 · G31 §1

