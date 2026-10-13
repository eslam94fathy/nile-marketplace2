# Scaling

Sizes live in `infra/terraform/envs/<env>/main.tf` (`sizes`, architecture §13.1); change them there, `plan`, review, `apply`. Load-test numbers: `docs/perf/p8-load-baseline.md` (local) and the P9 staging report.

| Lever | How | Watch out |
|---|---|---|
| More api tasks | `api_autoscaling.max` (prod) or `api_desired_count` | The service ignores `desired_count` after creation (autoscaling owns it): for a one-off change use `aws ecs update-service --desired-count`. Each task opens up to `DB_POOL_MAX` (10) connections: keep tasks × pool (api + worker + migrate) under the RDS `max_connections` of the instance class |
| Bigger api tasks | `api_cpu` / `api_memory` | Node uses one core per process: above 1 vCPU a task gains little; scale out instead. The P8 baseline saw one process saturate at ~150–180 req/s on a laptop core (P9-O2) |
| More workers | `worker_desired_count` | Safe: jobs take advisory locks, consumers compete on queues (architecture §1) |
| Bigger database | `rds_instance_class` | Applied in the maintenance window unless `apply_immediately`; single-AZ staging restarts (minutes of downtime), Multi-AZ prod fails over (about a minute). Search is the heaviest query (P9-O1) |
| More storage | automatic up to `rds_max_storage_gb` | The free-storage alarm fires first |
| Redis / RabbitMQ | `redis_node_type`, `mq_instance_type` | Both restart on a size change: brief reconnects; Redis loses its contents (rate-limit counters, idempotency keys, cache: acceptable, architecture §8) |

## Settings that must move together

- `IDEMPOTENCY_LOCK_TTL_SECONDS` (60) stays well above the longest request: statement timeout (`DB_STATEMENT_TIMEOUT_MS`, 10 s) plus provider calls (`KASHIER_HTTP_TIMEOUT_MS`, 10 s). If it were shorter, a duplicate could run while the first is still in flight (review F-9).
- The ALB deregistration delay and the ECS stop timeout are derived from `SHUTDOWN_TIMEOUT_MS` (+5 s) so in-flight requests finish during a deploy or scale-in.
- `RATE_LIMIT_*` are per IP (and per account where relevant); behind the ALB `TRUST_PROXY_HOPS = 1` makes the client IP correct. Never lift the general limit outside a load test.
