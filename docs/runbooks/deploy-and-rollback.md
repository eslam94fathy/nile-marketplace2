# Deploy and rollback

Architecture §13.1, plan §10. Commands assume the AWS CLI with a profile for the right account (`AWS_PROFILE=nile-staging` / `nile-prod`) and region `eu-central-1`. Terraform runs from the pinned image (`infra/terraform/README.md`).

## First deploy of an environment (P9 for staging; the go-live step for prod)

1. **Bootstrap the account** (`infra/terraform/README.md` → Bootstrap): state bucket, OIDC provider, `plan` and `deploy` roles.
2. **Fill `envs/<env>/backend.hcl` and `terraform.tfvars`** from the `.example` files. `image_tag` = the git SHA you are about to deploy.
3. **Cost estimate** (AWS Pricing Calculator from the sizes in `envs/<env>/main.tf`), approved before anything is created (P8-Q7).
4. **Check the region has the services** (P8-Q2): `aws rds describe-db-engine-versions --engine postgres --engine-version 18` and `aws mq describe-broker-instance-options --engine-type RABBITMQ --host-instance-type mq.m7g.medium`.
5. `tf envs/<env> init -backend-config=backend.hcl`, `tf envs/<env> plan -out=plan.tfplan`, review, `tf envs/<env> apply plan.tfplan`. The services start but can't run yet (no image, empty secrets): expected.
6. **DNS:** without Route 53, add the `certificate_validation_records` output at the DNS provider and point the API host at `alb_dns_name`. The certificate validates within minutes.
7. **Secrets:** fill every hand-filled secret (`secrets.md`).
8. **Kashier:** allow-list the `nat_public_ips` output in the Kashier dashboard (K-7) and set the webhook URL there if Kashier asks for one (sessions carry it, PA-1).
9. **Alerts:** confirm the SNS subscription email sent to `alert_email`.
10. **GitHub:** create the environment (`staging` or `production`; production with required reviewers) and its variables from `terraform output deploy` (list in `infra/terraform/README.md` → Pipelines). Repository variable `DEPLOY_ENABLED = true` (and `PRODUCTION_ENABLED = true` at go-live).
11. **Deploy:** run the `Deploy` workflow by hand (`workflow_dispatch`) on `main`. It pushes the image, migrates, rolls the services and checks `/health/ready`.
12. **First admin:** `seed-admin.md`.
13. **Smoke test:** `GET https://<host>/health/ready` shows Postgres, Redis and RabbitMQ up over TLS; the walkthrough scripts pass (P8-Q16).

## Routine deploy

Merge to `main` → CI green → `Deploy` runs on its own: build once → staging (push, migrate, roll, readiness) → production after an approval on the `production` environment. A failed migration stops before any service changes; a task that won't start is rolled back by the ECS circuit breaker.

Configuration changes (env, sizes, secrets) go through Terraform (`plan`, review, `apply` by hand) and reach the tasks with the next deploy: the deploy registers its task definitions from the latest revision Terraform wrote. To apply one without a code change: `aws ecs update-service --cluster nile-<env> --service api --force-new-deployment` (and `worker`); a changed **secret value** needs this too, since tasks read secrets at start.

Migrations are expand/contract (CLAUDE.md §6.1): a deploy never removes what the running version still uses; the contract step ships in a later deploy.

## Rollback

Run the `Rollback` workflow by hand: environment + the git SHA of the last good image (any of the last 30 in ECR, see the `Deploy` history). It rolls api and worker back to that image **without migrations** (an older image doesn't know the newer migrations and Knex refuses to run them; expand/contract keeps the older version working on the newer schema), then checks readiness.

A broken migration is fixed **forward** (a new migration in a new deploy), never by rolling back the schema in production; `down` migrations are for development.

## Checks after any deploy

- `/health/ready` 200; the `Deploy` run green.
- No alarm in the next 15 minutes (errors, dead-lettered events, 5xx, unhealthy targets).
- Logs: `aws logs tail /nile/<env>/api --since 15m --filter-pattern '{ $.level = "error" }'` (same for `worker`).
