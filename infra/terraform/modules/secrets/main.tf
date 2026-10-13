# One Secrets Manager secret per sensitive env key (architecture §13.1, P8-Q10), injected into the
# tasks as env vars by name. Two kinds:
# - generated: Terraform knows the value (connection URLs built from generated passwords);
# - manual: created empty here and filled by hand with `aws secretsmanager put-secret-value`, so the
#   value never passes through Terraform or its state (JWT keys, Kashier, Mailjet, encryption keys).
#   A task that references a secret without a value fails to start: fill them before the first deploy.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.64.0, < 7.0.0"
    }
  }
}

resource "aws_secretsmanager_secret" "generated" {
  for_each                = toset(nonsensitive(keys(var.generated)))
  name                    = "${var.prefix}/${each.key}"
  recovery_window_in_days = var.recovery_window_days
}

resource "aws_secretsmanager_secret_version" "generated" {
  for_each      = toset(nonsensitive(keys(var.generated)))
  secret_id     = aws_secretsmanager_secret.generated[each.key].id
  secret_string = var.generated[each.key]
}

resource "aws_secretsmanager_secret" "manual" {
  for_each                = toset(var.manual)
  name                    = "${var.prefix}/${each.key}"
  description             = "Filled by hand (docs/runbooks/secrets.md); never set by Terraform."
  recovery_window_in_days = var.recovery_window_days
}
