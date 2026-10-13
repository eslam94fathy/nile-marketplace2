# First admin

The first admin of an environment is created by the `seed-admin` CLI (P1-Q7, spec 03 UC-ID-8): it creates an invited admin and emails the invite; the person accepts it in the app and sets a password. Later admins are invited by an admin (`POST /admin/admins`).

On AWS it runs as a one-off task of the **migrate** task definition (it has the database, invite and encryption keys), with the command overridden:

```sh
ENV=staging
CLUSTER=nile-$ENV
SUBNETS=<ECS_SUBNET_IDS, comma-separated>      # terraform output deploy
SG=<ECS_SECURITY_GROUP_ID>
aws ecs run-task --cluster "$CLUSTER" --task-definition "nile-$ENV-migrate" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"migrate","command":["node","dist/seed-admin.js","--email","admin@example.com"]}]}'
```

Then: `aws logs tail /nile/$ENV/migrate --since 10m` shows the result; the invite email arrives through Mailjet (the worker sends it from the outbox). The invite link uses `INVITE_URL_BASE` and expires after `INVITE_TTL_HOURS` (72 h); if it lapses, run the command again for the same email or have another admin resend it.

Locally: `docker compose run --rm api node dist/seed-admin.js --email you@example.com` (Mailpit receives the email).
