# Nile Marketplace

REST API for Nile, a multi-vendor marketplace (one currency, EGP). Customers buy from approved sellers, and an order with items from several sellers is split into one sub-order per seller. The platform takes a commission per sale (set per seller, 10% by default). Customers pay cash on delivery (COD) or online through Kashier, and the platform's own delivery agents deliver the orders. The main client is a mobile app.

It is a **modular monolith**: one deployable and one PostgreSQL database, split into strongly isolated business modules that could later be extracted into services.

## Stack

| Concern     | Choice                                                                               |
| ----------- | ------------------------------------------------------------------------------------ |
| Runtime     | Node.js 24 LTS, TypeScript (strict), npm                                             |
| HTTP        | Express 5, class-validator DTOs, OpenAPI 3 generated from the DTOs                   |
| Data        | PostgreSQL 18 via Knex (raw-SQL migrations), Redis (cache, rate limits, idempotency) |
| Messaging   | Transactional outbox, then RabbitMQ 4.2, drained by a separate worker process        |
| DI / config | tsyringe, zod-validated env with no defaults                                         |
| Auth        | RS256 access JWT (`jose`) plus rotating refresh tokens, bcrypt passwords             |
| Tests       | Vitest, Supertest, Testcontainers (real Postgres, Redis, RabbitMQ)                   |
| Deploy      | Docker on AWS (ECS Fargate, RDS, ElastiCache, Amazon MQ), Terraform                  |

## Modules

`src/app/` holds one folder per bounded context. A module exposes only its `index.ts` to the others; ESLint enforces this.

| Module          | Responsibility                                                            |
| --------------- | ------------------------------------------------------------------------- |
| `identity`      | Accounts, login, refresh tokens, OTP, password reset, invites, suspension |
| `customers`     | Customer profiles and addresses                                           |
| `sellers`       | Seller registration, approval, commission rate                            |
| `catalog`       | Categories, products, variants, attributes, search and filters            |
| `inventory`     | Stock per variant, reservations, stock history                            |
| `cart`          | Customer carts                                                            |
| `ordering`      | Checkout, orders and seller sub-orders, cancellation                      |
| `payments`      | COD and Kashier payments, webhooks, manual refunds                        |
| `delivery`      | Governorates and delivery fees, agents, shipments                         |
| `finance`       | Ledger, statements, COD remittances, seller payouts                       |
| `notifications` | Transactional email (OTP, password reset, invites)                        |
| `health`        | `GET /health/live` and `GET /health/ready`                                |

Processes built from the same image:

- `dist/server.js`: the HTTP API
- `dist/worker.js`: outbox drain, event consumers, scheduled jobs
- `dist/migrate.js`: migrations
- `dist/seed-admin.js`: creates the first admin

## Getting started

Requirements: Node 24 (`nvm use` reads `.nvmrc`) and Docker.

```sh
npm ci
npm run dev:env              # creates a git-ignored .env with local values and a dev JWT key pair
docker compose up --build    # Postgres, Redis, RabbitMQ, Mailpit, then migrate, api, worker and realtime
npm run seed:dev             # optional: delivery fees, a demo seller with a catalog, a demo agent
```

Once it's running:

- API: `http://localhost:3000/api/v1`
- Swagger UI: `http://localhost:3000/api/v1/docs`
- Mailpit, the local inbox for every email: `http://localhost:8025`
- RabbitMQ management: `http://localhost:15672` (user and password `nile`)

To create an admin, run `docker compose run --rm api node dist/seed-admin.js --email you@example.com` and accept the invite emailed to Mailpit.

Locally, payments use a fake gateway (`PAYMENT_GATEWAY=fake`). `npm run dev:kashier-webhook` sends a signed Kashier webhook to the local API. To use the Kashier test environment, set `PAYMENT_GATEWAY=kashier` and the Kashier keys in `.env`.

### Running the app outside Docker

Keep the dependencies in Docker (`docker compose up -d postgres redis rabbitmq mailpit`), then run each of these in its own terminal:

```sh
npm run dev:build     # tsc --watch
npm run migrate
npm run dev:api       # node --watch --env-file=.env
npm run dev:worker
npm run dev:realtime  # Socket.IO gateway on PORT 3001 (.env.realtime)
```

## Scripts

| Script                                          | What                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `build` / `typecheck`                           | Compile to `dist/` / type-check everything, including tests                     |
| `lint` / `format` / `format:check`              | ESLint (with the module-boundary rules) / Prettier                              |
| `test:unit` / `test:integration` / `test`       | Vitest. Integration tests start their own containers, so Docker must be running |
| `migrate` / `migrate:rollback` / `migrate:make` | Apply, roll back, or create a migration                                         |
| `seed:admin` / `seed:dev` / `perf:seed`         | First admin / sample data / load-test data                                      |
| `postman:generate`                              | Regenerate `docs/postman/nile-marketplace.postman_collection.json`              |

## Configuration

Every setting comes from environment variables, validated at startup. There are no defaults: a missing or invalid key stops the process and the error names the key. `.env.example` lists every key. Each process validates only the keys it needs (`src/lib/config/env.schema.ts`). Never commit `.env`.

## Repository layout

```
src/
  app/          business modules (see above)
  lib/          app infrastructure: config, db, DI, logger, HTTP, errors, middleware, events
  pkg/          framework-agnostic utilities; never imports from app/ or lib/
  migrations/   raw-SQL Knex migrations
test/
  integration/  HTTP to database tests against real containers
  load/         k6 load-test scenarios
infra/terraform/  AWS infrastructure (bootstrap, modules, envs/staging, envs/prod)
scripts/        dev and deploy tooling
docs/           spec, design, plan, runbooks, security review, Postman collection
```

## Documentation

| Where                                                            | What                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`CLAUDE.md`](CLAUDE.md)                                         | Engineering rules and the decisions log. Binding for every change     |
| [`docs/spec/`](docs/spec/)                                       | Business spec, one file per module. The source of truth for behaviour |
| [`docs/design/`](docs/design/)                                   | Architecture and database design                                      |
| [`docs/plan/`](docs/plan/00-implementation-plan.md)              | Phased implementation plan and status                                 |
| [`docs/runbooks/`](docs/runbooks/README.md)                      | Deploy, rollback, secrets, first admin, restore, scaling, maintenance |
| [`docs/security/p8-review.md`](docs/security/p8-review.md)       | Security review                                                       |
| [`docs/perf/p8-load-baseline.md`](docs/perf/p8-load-baseline.md) | Local load-test baseline                                              |
| [`infra/terraform/README.md`](infra/terraform/README.md)         | Infrastructure layout, bootstrap and pipelines                        |
| [`test/load/README.md`](test/load/README.md)                     | Running the load test                                                 |

## CI and deployment

GitHub Actions:

- `ci.yml` runs on every PR and every push to `main`: lint, format, type-check, unit and integration tests, build, Docker image build, Trivy image and config scans, and `npm audit`.
- `infra.yml` runs offline Terraform checks: fmt, validate and test.
- `deploy.yml` deploys and `rollback.yml` rolls back by image SHA. Both are switched off until the repository variable `DEPLOY_ENABLED` is set, and production also needs `PRODUCTION_ENABLED`.

**Status:** the AWS infrastructure is written but not applied yet. The staging deploy is phase 9.
