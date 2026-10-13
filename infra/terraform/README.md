# Infrastructure (Terraform)

AWS infrastructure of Nile Marketplace (architecture §13 and §13.1, plan §10). Region `eu-central-1` (SD-3d). Two AWS accounts, staging and prod (P8-Q4).

**Status (P8): written and checked offline only.** Nothing here has been applied. Staging is applied in P9 (staging deploy); prod at a separate go-live with its own approval (P8-Q3).

## Layout

| Path                        | What                                                                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.terraform-version`        | Terraform version (1.16.4); the AWS provider is pinned to 6.64.0 in each root, with the lock file committed                                                                                                    |
| `bootstrap/`                | Once per account: the state bucket (versioned, KMS-encrypted, TLS only), the GitHub OIDC provider, the read-only `nile-github-plan` role and the `nile-github-deploy` role                                     |
| `modules/network`           | VPC over 2 AZs, public subnets (ALB, NAT only), private subnets, NAT gateway(s) with fixed egress IPs (Kashier allow-list, K-7), S3 endpoint, flow logs of rejected traffic                                    |
| `modules/alb`               | Public ALB, ACM certificate (DNS validation), HTTP → HTTPS, TLS 1.2+ policy, target group on `/health/live`                                                                                                    |
| `modules/ecs-service`       | One Fargate task definition (+ service): api, worker, or the migrate task definition. Log group, execution role (image, secrets, logs), an empty task role, circuit-breaker rollback, optional CPU autoscaling |
| `modules/rds`               | PostgreSQL 18, private, encrypted, `rds.force_ssl = 1`, PITR backups, generated password                                                                                                                       |
| `modules/elasticache`       | Redis OSS 7.x, one node, TLS in transit + AUTH token (`rediss://`)                                                                                                                                             |
| `modules/amazon-mq`         | RabbitMQ 4.2 single instance, private, `amqps://`                                                                                                                                                              |
| `modules/secrets`           | One Secrets Manager secret per sensitive env key: generated (connection URLs) or created empty and filled by hand                                                                                              |
| `modules/ecr`               | The image repository: immutable tags, scan on push, keeps the last N images                                                                                                                                    |
| `modules/alarms`            | SNS email topic; alarms on error / fatal log lines, dead-lettered events, ALB 5xx, unhealthy targets, RDS CPU and free storage                                                                                 |
| `modules/environment`       | One whole environment wired from the modules above; derives the values fixed once deployed and gives each process only its own env keys and secrets (`env-keys.json`)                                          |
| `envs/staging`, `envs/prod` | The environment roots: sizes (architecture §13.1) and every non-secret setting, explicitly                                                                                                                     |

Modules are our own (no community modules), so every resource is reviewed here (P8-Q5).

## Configuration of the processes

`modules/environment/env-keys.json` lists, per process (api, worker, migrate), the env keys the roots set (`settings`), the ones the module derives (`NODE_ENV`, `DB_SSL=true`, `PAYMENT_GATEWAY=kashier`, `EMAIL_PROVIDER=mailjet`, `KASHIER_WEBHOOK_URL`, `TRUST_PROXY_HOPS=1`, service names, port) and the secrets. Two guards keep it right:

- `src/lib/config/__tests__/terraform-env-keys.test.ts` (unit tests, CI): the lists equal the zod env schemas, so a new env key can't be forgotten here.
- `modules/environment/tests/settings.tftest.hcl` (`terraform test`, mocked providers, no AWS): a missing, unknown or derived key in `settings` fails the plan; each process gets only its own keys and secrets.

Secrets: Terraform writes `DATABASE_URL`, `REDIS_URL` and `RABBITMQ_URL`; the others (`manual_secrets`) are created empty and filled by hand before the first deploy, so their values never enter the state.

## Running Terraform

Nothing to install: use the pinned image. From this directory (Git Bash on Windows needs `MSYS_NO_PATHCONV=1`):

```sh
tf() { docker run --rm -it -v "$PWD:/tf" -w "/tf/$1" -e AWS_PROFILE -v "$HOME/.aws:/root/.aws:ro" hashicorp/terraform:1.16.4 "${@:2}"; }
tf bootstrap init
tf bootstrap plan -var-file=staging.tfvars
```

Offline checks (what CI runs, no AWS credentials needed):

```sh
tf . fmt -check -recursive
tf envs/staging init -backend=false && tf envs/staging validate   # each root (bootstrap, envs/staging, envs/prod) validates the modules it uses
tf modules/environment init -backend=false && tf modules/environment test
docker run --rm -v "$PWD:/src" aquasec/trivy:0.74.0 config --exit-code 1 --severity HIGH,CRITICAL --skip-dirs "**/.terraform" /src
```

## Pipelines

- `.github/workflows/infra.yml`: on PRs touching `infra/`, the offline checks above. `plan` per environment with the read-only role is added in P9. `apply` is never run by CI.
- `.github/workflows/deploy.yml` → `deploy-environment.yml` → `scripts/deploy/ecs-deploy.sh`: CI green on `main` → build the image once → staging (push to ECR, migrate task, roll api and worker, `/health/ready`) → production behind required reviewers, same image. **Off until P9**: needs the repository variable `DEPLOY_ENABLED = true`; production also `PRODUCTION_ENABLED = true` (go-live). Each GitHub environment (`staging`, `production`) needs the variables `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY_URL`, `API_BASE_URL` and, from `terraform output deploy`, `ECS_CLUSTER`, `ECS_API_SERVICE`, `ECS_WORKER_SERVICE`, `ECS_API_FAMILY`, `ECS_WORKER_FAMILY`, `ECS_MIGRATE_FAMILY`, `ECS_SUBNET_IDS` (comma-separated), `ECS_SECURITY_GROUP_ID`.
- `.github/workflows/rollback.yml` (by hand): one environment back to an earlier image by git SHA, without migrations (`docs/runbooks/deploy-and-rollback.md`). Off until P9, like the deploy.
- Terraform owns the task definitions' env, secrets and sizes; the deploy only swaps the image (the services ignore `task_definition` in Terraform). A Terraform change reaches the tasks with the next deploy.

## Bootstrap (P9, once per account)

Run by the user's bootstrap admin identity in that account, with `bootstrap/terraform.tfvars.example` copied to `<env>.tfvars`:

1. `tf bootstrap init` and `tf bootstrap apply -var-file=staging.tfvars` (local state).
2. Move the state into the bucket it created: add a `backend "s3"` block (bucket, key `bootstrap/terraform.tfstate`, region, `use_lockfile = true`, `encrypt = true`, `kms_key_id` from the outputs) and run `tf bootstrap init -migrate-state`; delete the local state file.
3. Put the outputs where they are used: `state_bucket` and `state_kms_key_arn` into `envs/<env>/backend.hcl`; `plan_role_arn` and `deploy_role_arn` into the GitHub repository variables (`AWS_PLAN_ROLE_ARN`, `AWS_DEPLOY_ROLE_ARN`) of that environment.

The roles trust only this repository: `plan` any ref, `deploy` only `main` and the protected GitHub environment of that account (`staging`, or `production` for the prod account).

## Decisions

Architecture §13.1 (P8-Q3…Q15) is the source; this README only explains how to use the code. Accepted scanner findings carry a `#trivy:ignore` with the reason on the line above.
