# Load test

k6 scenarios for the CLAUDE.md §15 targets (plan §10, P8-Q13). **P8:** a local baseline on docker-compose: it finds slow queries and tunes settings, it does **not** prove the production targets (one laptop runs the database, the app and k6). **P9:** the same script against staging scaled to production sizes; the thresholds in `scenarios.js` are then the pass criteria (300 req/s for 10 minutes, p95 < 300 ms for reads and < 500 ms for checkout, < 0.1 % errors).

Results: `docs/perf/p8-load-baseline.md`.

## Files

| File                            | What                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenarios.js`                  | The traffic mix: product lists (with a second page), search with typos, category + attribute filters, product detail, reference data, account lists (customer, seller, admin), and a cart → COD checkout flow |
| `vocabulary.json`               | Product-name words used by `scripts/perf-seed.js`, and the search terms                                                                                                                                       |
| `.data/` (git-ignored)          | `perf-data.json` (signed tokens and ids written by the seed) and run outputs                                                                                                                                  |
| `../../docker-compose.perf.yml` | Compose override for the run: `pg_stat_statements`, and the general per-IP rate limit lifted (k6 is one IP)                                                                                                   |

## Running the local baseline

```sh
docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d --build
npm run seed:dev && npm run perf:seed            # once per database volume (~2 minutes)
docker compose exec -T postgres psql -U nile -d nile -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements; SELECT pg_stat_statements_reset();"
docker run --rm -v "$PWD/test/load:/load" -w /load grafana/k6:2.3.0 run --summary-export=.data/summary.json scenarios.js \
  -e BASE_URL=http://host.docker.internal:3000 -e RATE=300 -e DURATION=10m
```

`RATE` is the total request rate of the read scenarios; the checkout flow adds `CHECKOUTS_PER_SECOND` (2.5) × 3 requests. The slowest statements afterwards:

```sh
docker compose exec -T postgres psql -U nile -d nile -c "SELECT calls, round(mean_exec_time) AS mean_ms, left(query, 120) FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15;"
```

The seed refuses to run twice on one database; `docker compose down -v` starts from an empty volume (and deletes all local data). Tokens in `perf-data.json` are valid for 6 hours: run the seed again on a fresh volume, or re-sign them, after that.
