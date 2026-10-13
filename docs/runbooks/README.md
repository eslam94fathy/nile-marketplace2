# Runbooks

Operating Nile Marketplace on AWS (architecture §13 and §13.1, plan §10). Written in P8 before anything is deployed; checked and corrected during P9 (staging) and the production go-live.

| Runbook | For |
|---|---|
| [deploy-and-rollback.md](deploy-and-rollback.md) | The first deploy of an environment, routine deploys, rollback, checks after a deploy |
| [secrets.md](secrets.md) | Filling the hand-filled secrets, rotating every key, a suspected leak |
| [seed-admin.md](seed-admin.md) | Creating the first admin of an environment |
| [restore.md](restore.md) | The point-in-time restore drill and a real recovery |
| [scaling.md](scaling.md) | Sizes, counts and the settings that must move together |
| [maintenance.md](maintenance.md) | Recurring work: image and dependency updates, the RDS CA bundle, scans, versions |

Infrastructure code: `infra/terraform/` (its README covers bootstrap and the pipelines). Alarms go to the SNS email topic of each environment (P8-Q15); logs are in CloudWatch under `/nile/<env>/{api,worker,migrate}`.
