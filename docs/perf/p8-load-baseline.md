# P8 load-test baseline (local, 2026-10-13)

Plan §10 step 6, P8-Q13. **A laptop baseline, not proof of the production targets:** the database, Redis, RabbitMQ, one api process, one worker and k6 all ran on one machine. Its purpose is to find slow queries and capacity limits before staging; the target check (300 req/s for 10 minutes, p95 < 300 ms reads / < 500 ms checkout, < 0.1 % errors) runs in P9 on staging at production sizes.

## Setup

| | |
|---|---|
| Machine | Intel i7-1185G7 (4 cores / 8 threads), 16 GB; Docker Desktop VM with 8 CPUs, 8 GB |
| Stack | docker-compose from `p8-hardening` with `docker-compose.perf.yml` (pg_stat_statements; general per-IP limit lifted, k6 is one IP). One api, one worker, `postgres:18`, `redis:7.2`, `rabbitmq:4.2`; `DB_POOL_MAX=10` |
| Data (`npm run perf:seed`) | 2,000 approved sellers; 100,000 active products in 20 leaf categories with a `size` attribute, 300,000 variants; 100,000 customers with addresses; 200,000 placed COD orders with seller orders, lines and payments; 100,000 ledger entries |
| Product names | `<adjective> <noun> <brand> <n>` from `test/load/vocabulary.json` (40 / 200 / 50 words): a noun matches ~0.5 % of the catalog, a brand ~2 % |
| Load (`test/load/scenarios.js`) | k6 2.3.0, open model (constant arrival rate). Reads: 37 % lists (30 % fetch a second page), 20 % search with typos, 15 % category + attribute filters, 17 % product detail, 5 % reference data, 4 % account lists (customer, seller, admin, finance). Plus cart add → cart → COD checkout |

## Findings

| # | Finding | Status |
|---|---|---|
| L-1 | **Price sort without a category** read and sorted all 100k visible products (144 ms in the database alone, ~300 ms under load): only per-category price indexes existed | **Fixed**: `idx_products_min_price_id` (D-13, database v1.13); now p50 7 ms through the API |
| L-2 | **Search is the database's bottleneck.** At 100 req/s mixed it used **367 of 393 database-seconds (93 %)** while being 20 % of requests. Per search 13–24 ms of database time when idle (ts_rank + word_similarity over every match: 500–2,000 rows), 99 ms on average under contention. At the target mix (≈60 searches/s) that alone needs more than the 2 vCPUs of the planned `db.m7g.large` | **Open for P9** (P9-O1 below) |
| L-3 | **One api process saturates at about 150–180 req/s** on this CPU (search turned off: api at 108 % CPU, database at 54 % with 13 database-seconds in 2 minutes). Node uses one core per process; a Fargate task of 0.5 vCPU has half a core, so the planned 2–4 api tasks (P8-Q7) are likely short of 300 req/s | **Open for P9** (P9-O2) |
| L-4 | **The worker crashed under overload.** At 300 req/s the machine stalled (DNS and pool timeouts); a failed connection acquisition in the job runner was an unhandled rejection, which stops the process by design (CLAUDE.md §9.1) | **Fixed**: the job runner skips the run and logs `JOB_FAILED`; the scheduler also catches anything unexpected. Regression test `job-runner.test.ts` |
| L-5 | **Overload answers 500.** When the database pool is exhausted, requests fail with `Knex: Timeout acquiring a connection` and the generic `500 INTERNAL_ERROR` (1,314 of them in the aborted 300 req/s run); 5 requests hit the 10 s statement timeout. A `503 SERVICE_UNAVAILABLE` with `Retry-After` would tell the app to retry and keep these out of the 5xx-bug alarm | **Open** (P9-O3) |
| L-6 | Typo threshold (P3-O1): with the realistic names, **0.35 is right**: 0.3 widens `hedphones` to every "phone"; 0.5 loses `jaket`, 0.6 also `kettel` and `sneekers`; 0.35 and 0.4 find every intended product | Kept at 0.35 |
| L-7 | Admin seller list `businessName like` (P2): 4.4 ms (sequential scan over 2,000 sellers); no trigram index needed | No change |

## Latency per endpoint, no other load (40 requests each, through the API)

| Endpoint | p50 | p95 |
|---|---|---|
| `GET /products` (newest) | 8.3 ms | 21.7 ms |
| `GET /products?sort=minPrice` (after D-13) | 7.1 ms | 12.9 ms |
| `GET /products?q=kettle` (noun) | 45.9 ms | 65.6 ms |
| `GET /products?q=nilex` (brand) | 37.2 ms | 64.5 ms |
| `GET /products?q=hedphones` (typo) | 39.8 ms | 64.5 ms |
| `GET /products?categoryId=…&attr.size[in]=m` | 11.1 ms | 29.5 ms |
| `GET /products/:slug` | 11.0 ms | 14.2 ms |
| `GET /categories` | 5.2 ms | 10.6 ms |
| `GET /orders` (customer) | 8.6 ms | 10.6 ms |
| `GET /seller/orders` | 10.2 ms | 21.7 ms |
| `GET /seller/finance/entries` | 9.6 ms | 14.1 ms |
| `GET /admin/orders` | 10.6 ms | 15.2 ms |
| `GET /admin/finance/accounts` | 8.6 ms | 16.2 ms |

Every endpoint is well inside the budget on its own; the misses below come from saturation.

## Runs

| Run | Requests/s reached | Errors | p95 reads | p95 checkout | Notes |
|---|---|---|---|---|---|
| Smoke, 45 s, before L-1 and the vocabulary | 33 | 0 % | 1.45 s | 2.76 s | 16-noun names: a word matched 6 % of the catalog |
| 300 req/s target, 10 min | – | 1,322 failed | – | – | **Aborted after ~5 min**: the laptop stalled (k6 at ~1,000 VUs plus the stack); found L-4, L-5 |
| Mixed, 100 req/s (+1 checkout/s), 3 min | 111 | 0 % | 1.00 s | 2.11 s | Database saturated by search (L-2) |
| Search off, 200 req/s (+1 checkout/s), 2 min | 179 (k6 could not reach 200) | 0 % | 953 ms | 2.27 s | Api CPU-bound at 108 % (L-3); database at 54 % |

No functional errors in any completed run: all 15 checks passed on every request (cart, checkout and the account lists included).

## Open for P9 (CLAUDE.md §14.2)

- **P9-O1 Search cost (L-2).** Re-measure on staging at production sizes. If search still dominates, the options (spec 06 change): (a) **two-phase search**: full-text first, and only when it returns fewer than a page, add the trigram (typo) matches, so most searches skip the trigram scan and word_similarity; (b) rank only the best N candidates; (c) a short-lived Redis cache of popular search pages (architecture §8 says lists are not cached in R1).
- **P9-O2 Api capacity per task (L-3).** Measure requests/s per task on staging. Likely outcome: 1 vCPU tasks, or more of them (autoscaling max above 4); the cost estimate follows.
- **P9-O3 Overload status (L-5).** Map a pool-acquire timeout to `503 SERVICE_UNAVAILABLE` + `Retry-After` instead of `500` (error handler, CLAUDE.md §9.1 change).
