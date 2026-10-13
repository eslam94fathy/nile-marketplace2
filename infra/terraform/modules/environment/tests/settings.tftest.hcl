# Offline plan of a whole environment with mocked providers (no AWS account): the settings check,
# the per-process env and secrets (P1-Q1, CLAUDE.md §4) and the derived values. Run by infra.yml.

mock_provider "aws" {
  override_data {
    target = module.network.data.aws_availability_zones.available
    values = { names = ["eu-central-1a", "eu-central-1b", "eu-central-1c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

mock_provider "random" {}

variables {
  environment_name = "staging"
  region           = "eu-central-1"
  cidr_block       = "10.20.0.0/16"
  domain_name      = "api.staging.example.com"
  route53_zone_id  = null
  alert_email      = "ops@example.com"
  image_tag        = "0123abcd"
  sizes = {
    nat_gateway_count         = 1
    log_retention_days        = 14
    deletion_protection       = false
    container_insights        = false
    rds_instance_class        = "db.t4g.small"
    rds_multi_az              = false
    rds_storage_gb            = 20
    rds_max_storage_gb        = 100
    rds_backup_retention_days = 7
    redis_node_type           = "cache.t4g.micro"
    mq_instance_type          = "mq.m7g.medium"
    api_cpu                   = 512
    api_memory                = 1024
    api_desired_count         = 1
    api_autoscaling           = null
    worker_cpu                = 512
    worker_memory             = 1024
    worker_desired_count      = 1
    error_log_alarm_threshold = 5
    alb_5xx_alarm_threshold   = 10
  }
  # Every settings key once, with a recognisable value.
  settings = { for key in distinct(concat(
    jsondecode(file("env-keys.json")).common, jsondecode(file("env-keys.json")).database,
    jsondecode(file("env-keys.json")).api, jsondecode(file("env-keys.json")).worker,
    jsondecode(file("env-keys.json")).migrate,
  )) : key => key == "SHUTDOWN_TIMEOUT_MS" ? "20000" : "v-${key}" }
}

run "complete_settings_plan" {
  command = plan

  # Derived for a deployed environment (review F-3, PA-5, P1-Q2, P8-Q11).
  assert {
    condition = alltrue([
      output.process_environment.api.NODE_ENV == "staging",
      output.process_environment.api.DB_SSL == "true",
      output.process_environment.api.SERVICE_NAME == "nile-api",
      output.process_environment.api.TRUST_PROXY_HOPS == "1",
      output.process_environment.api.PAYMENT_GATEWAY == "kashier",
      output.process_environment.api.KASHIER_WEBHOOK_URL == "https://api.staging.example.com/api/v1/webhooks/kashier",
      output.process_environment.worker.EMAIL_PROVIDER == "mailjet",
      output.process_environment.worker.SERVICE_NAME == "nile-worker",
      output.process_environment.migrate.SERVICE_NAME == "nile-migrate",
    ])
    error_message = "derived values are wrong"
  }

  # Each process gets only its own keys (P1-Q1).
  assert {
    condition = alltrue([
      !contains(keys(output.process_environment.worker), "REDIS_KEY_PREFIX"),
      !contains(keys(output.process_environment.worker), "JWT_ISSUER"),
      !contains(keys(output.process_environment.api), "OUTBOX_BATCH_SIZE"),
      !contains(keys(output.process_environment.api), "MAILJET_FROM_EMAIL"),
      !contains(keys(output.process_environment.migrate), "PORT"),
      output.process_environment.api.SEARCH_WORD_SIMILARITY_THRESHOLD == "v-SEARCH_WORD_SIMILARITY_THRESHOLD",
    ])
    error_message = "a process received another process's keys"
  }

  assert {
    condition = alltrue([
      contains(output.process_secret_keys.api, "JWT_PRIVATE_KEY"),
      !contains(output.process_secret_keys.worker, "JWT_PRIVATE_KEY"),
      !contains(output.process_secret_keys.api, "MAILJET_SECRET_KEY"),
      contains(output.process_secret_keys.worker, "MAILJET_SECRET_KEY"),
      toset(output.process_secret_keys.migrate) == toset(["DATABASE_URL", "SECRETS_ENCRYPTION_KEYS"]),
    ])
    error_message = "secrets went to the wrong process"
  }
}

run "missing_setting_fails" {
  command = plan
  variables {
    settings = { for key, value in var.settings : key => value if key != "BCRYPT_COST" }
  }
  expect_failures = [terraform_data.settings_check]
}

run "unknown_setting_fails" {
  command = plan
  variables {
    settings = merge(var.settings, { BCRYPT_COSTT = "12" })
  }
  expect_failures = [terraform_data.settings_check]
}

run "derived_key_is_refused_as_a_setting" {
  command = plan
  variables {
    settings = merge(var.settings, { NODE_ENV = "development" })
  }
  expect_failures = [terraform_data.settings_check]
}
