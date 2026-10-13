# Maintenance

| Task | When | How |
|---|---|---|
| **Image security updates** | CI scans every PR (Trivy, high / critical with a fix fails) | The runtime image applies Debian security updates at build time (Dockerfile), so a rebuild picks them up: a no-op merge or `workflow_dispatch` of `Deploy` ships them. Bump `NODE_IMAGE` for Node patch releases |
| **npm dependencies** | CI runs `npm audit --audit-level=high` on every PR | Update, run the full CI, deploy. New dependencies need approval (CLAUDE.md §1) |
| **Amazon RDS CA bundle** | When AWS publishes a new one (the build fails on the checksum, or AWS announces a CA rotation) | Download `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`, check it (certificate count, issuers, expiry dates), put its SHA-256 into `RDS_CA_BUNDLE_SHA256` in the Dockerfile. Without it the app can't verify the database certificate (P8-Q9) |
| **Secret scan of the history** | Before the production go-live, then yearly | `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 git /repo --redact --log-opts="--all"` (review, plan step 3) |
| **Restore drill** | P9, then quarterly | `restore.md` |
| **Key rotation** | JWT and encryption keys yearly or on suspicion; provider keys per provider policy | `secrets.md` |
| **Engine versions** | Minor versions are AWS-managed (auto minor upgrade in the maintenance windows); majors are planned | Postgres majors: test on staging first, `engine_version` in Terraform. RabbitMQ: Amazon MQ manages the patch version of 4.2 and gives at least 90 days' notice of an end of support |
| **Terraform and the AWS provider** | When a fix or a needed feature lands | Bump `.terraform-version` / the pinned provider, regenerate the lock files (`providers lock` for the five platforms), run `infra.yml` checks, then `plan` both environments: expect no changes |
| **Load test** | Before a campaign or after a large change | `test/load/README.md` (against staging at production sizes) |
