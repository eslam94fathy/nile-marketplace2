# Database restore

RDS keeps automated backups with point-in-time recovery: 7 days in staging, 14 in prod (architecture §13.1). Postgres is the only source of truth: Redis holds nothing that must survive (architecture §8), and RabbitMQ messages are re-published from the outbox.

## Drill (P9, then every quarter)

Restores to a **new** instance next to the live one; nothing live changes.

```sh
ENV=staging
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "nile-$ENV" \
  --target-db-instance-identifier "nile-$ENV-restore-drill" --restore-time "<UTC time, e.g. 2026-11-02T08:00:00Z>" \
  --db-subnet-group-name "nile-$ENV" --vpc-security-group-ids <the db security group> --no-publicly-accessible
aws rds wait db-instance-available --db-instance-identifier "nile-$ENV-restore-drill"
```

Check it from a one-off task (the migrate task definition with `DATABASE_URL` overridden, or `psql` from a bastion if one exists): row counts of `orders`, `ledger_entries`, `users` close to the live ones at that time; `SELECT max(created_at) FROM orders` ≈ the restore time; the latest migration in `knex_migrations` is the deployed one. Write down how long the restore took (that is the recovery time to expect), then delete it:

```sh
aws rds delete-db-instance --db-instance-identifier "nile-$ENV-restore-drill" --skip-final-snapshot
```

## Real recovery (data loss or corruption)

1. Stop writes: scale `api` and `worker` to 0 (`aws ecs update-service --desired-count 0`), so nothing more is written to the damaged database.
2. Restore to a new instance at the last good moment (as above).
3. Point the environment at it: the instance is Terraform-managed, so the switch is a Terraform change (import the restored instance, or restore under the original identifier after renaming the damaged one) followed by `apply`, which rewrites `DATABASE_URL`. **Prepare and rehearse this change during the P9 drill**; it is not something to write during an incident.
4. Start `worker` then `api` again (desired counts back), watch `/health/ready` and the alarms.
5. Events between the restore point and the incident are lost with the data; reconcile with Kashier (payments) and the sellers for that window.
