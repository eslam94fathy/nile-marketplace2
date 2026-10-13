# Secrets

One Secrets Manager secret per sensitive env key, named `nile/<env>/<KEY>` (architecture §13.1, P8-Q10). Terraform writes `DATABASE_URL`, `REDIS_URL` and `RABBITMQ_URL`; the others are created empty and filled by hand, so their values never enter Terraform or its state. Tasks read secrets when they start: after changing a value, `aws ecs update-service --cluster nile-<env> --service api --force-new-deployment` (and `worker`). Never paste a secret into a ticket, chat, tfvars or a commit.

```sh
put() { aws secretsmanager put-secret-value --secret-id "nile/$ENV/$1" --secret-string "$2"; }
```

## Filling them (first deploy)

| Secret | Value |
|---|---|
| `JWT_PRIVATE_KEY` | `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt.pem`; the PEM as is (real newlines are fine in Secrets Manager). Kid = `jwt_active_kid` in tfvars, e.g. `staging-2026-10` |
| `JWT_PUBLIC_KEYS` | JSON `{"<kid>": "<public PEM>"}`; build it with jq so the PEM's newlines are escaped: `jq -n --arg kid "$KID" --arg pem "$(openssl pkey -in jwt.pem -pubout)" '{($kid): $pem}'` |
| `SECRETS_ENCRYPTION_KEYS` | JSON `{"<id>": "<base64 of 32 random bytes>"}`: `jq -n --arg id "$ID" --arg key "$(openssl rand -base64 32)" '{($id): $key}'`; id = `secrets_encryption_active_key_id` |
| `KASHIER_API_KEY`, `KASHIER_SECRET_KEY`, `KASHIER_MERCHANT_ID` | From the Kashier dashboard: **test** keys for staging, live for prod (`KASHIER_MODE` follows). No quoting needed here (PA-16 is about `.env` files) |
| `MAILJET_API_KEY`, `MAILJET_SECRET_KEY` | From Mailjet, with the verified sender in `mailjet_from_email` (P1-Q8) |

Delete the local `jwt.pem` and anything else written to disk once stored.

## Rotation

**JWT signing key** (P1-Q5), no logout for anyone:
1. New key pair with a new kid. Add its public key to `JWT_PUBLIC_KEYS` (keep the old one); force a new deployment: tokens of both keys verify.
2. Put the new private key into `JWT_PRIVATE_KEY`, set `jwt_active_kid` to the new kid, `terraform apply`, force a new deployment: new tokens use the new key.
3. After the access-token TTL (15 min), remove the old public key from `JWT_PUBLIC_KEYS`; force a new deployment. Refresh tokens are opaque and unaffected.

**Event-payload encryption key** (events §3.1): add a new key to `SECRETS_ENCRYPTION_KEYS`, force a new deployment, switch `secrets_encryption_active_key_id` (`terraform apply`, new deployment), and remove the old key after the outbox retention (`OUTBOX_RETENTION_DAYS`).

**Database password:** `tf envs/<env> apply -replace=module.environment.module.rds.random_password.master` changes the RDS password and the `DATABASE_URL` secret together; force a new deployment right after (running tasks keep their open connections until they restart, new connections fail in between: do it in a quiet hour).

**Redis AUTH token** and **RabbitMQ password**: same pattern with `module.environment.module.redis.random_password.auth` / `module.environment.module.mq.random_password.app`; ElastiCache and Amazon MQ apply the change in place. Expect a short reconnect.

**Kashier / Mailjet keys:** create the new key at the provider, `put` it, force a new deployment, then revoke the old one at the provider.

## Suspected leak

Rotate the affected secret now (above), revoke it at the provider, and check the logs for its use. The logger redacts secrets by key name (CLAUDE.md §9.2, review F-7); if a value ever shows up in a log, that is a bug.
