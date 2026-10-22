# One environment (staging or prod) wired from the other modules (architecture §13.1, plan §10).
# envs/staging and envs/prod call this with their sizes and every non-secret setting.
#
# Configuration (CLAUDE.md §4, P8-Q10): the roots pass every tunable env key in `settings`; keys that
# are fixed for a deployed environment are derived here. Each process gets only its own keys and
# secrets (P1-Q1). A missing or unknown key fails the plan.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.64.0, < 7.0.0"
    }
  }
}

locals {
  name     = "nile-${var.environment_name}"
  node_env = var.environment_name == "prod" ? "production" : "staging"
  api_port = 3000
  image    = "${module.ecr.repository_url}:${var.image_tag}"
  log_days = var.sizes.log_retention_days
  api_url  = "https://${var.domain_name}"
  # The Socket.IO gateway (spec 15, RT-1); its ECS service and ALB rule come with R2-P2 step 7.
  realtime_port = 3001
  # The media bucket's name (the s3-media module creates it, architecture §14.9).
  media_bucket = "${local.name}-media"
  # S3 through the task role; MinIO is refused once deployed (spec 14 §6).
  storage   = { STORAGE_PROVIDER = "s3", STORAGE_BUCKET = local.media_bucket, STORAGE_REGION = var.region }
  key_lists = jsondecode(file("${path.module}/env-keys.json"))

  # Fixed once deployed: the env schema refuses the alternatives (review F-3, PA-5, P1-Q2).
  derived = {
    common   = { NODE_ENV = local.node_env }
    database = { DB_SSL = "true" }
    api = merge(local.storage, {
      SERVICE_NAME        = "nile-api"
      PORT                = tostring(local.api_port)
      TRUST_PROXY_HOPS    = "1" # the ALB (P8-Q11)
      JWT_ALGORITHM       = "RS256"
      PAYMENT_GATEWAY     = "kashier"
      KASHIER_WEBHOOK_URL = "${local.api_url}/api/v1/webhooks/kashier"
    })
    worker = merge(local.storage, {
      SERVICE_NAME = "nile-worker", PAYMENT_GATEWAY = "kashier", EMAIL_PROVIDER = "mailjet"
    })
    realtime = {
      SERVICE_NAME     = "nile-realtime"
      PORT             = tostring(local.realtime_port)
      TRUST_PROXY_HOPS = "1" # the ALB, as the api
      JWT_ALGORITHM    = "RS256"
    }
    migrate = { SERVICE_NAME = "nile-migrate" }
  }

  # Every key the processes read from `settings` (the derived ones excluded).
  settings_keys = toset(distinct(concat(
    local.key_lists.common, local.key_lists.database, local.key_lists.api,
    local.key_lists.worker, local.key_lists.realtime, local.key_lists.migrate,
  )))

  pick = { for process in ["api", "worker", "realtime", "migrate"] : process => merge(
    # lookup: a missing key is reported by settings_check below, not as an index error.
    { for key in concat(local.key_lists.common, local.key_lists.database, local.key_lists[process]) : key => lookup(var.settings, key, "") },
    local.derived.common, local.derived.database, local.derived[process],
  ) }

  secret_names   = local.key_lists.secrets
  manual_secrets = local.key_lists.manual_secrets
}

# A missing key or a typo fails here, before anything changes.
resource "terraform_data" "settings_check" {
  input = keys(var.settings)
  lifecycle {
    precondition {
      condition     = length(setsubtract(local.settings_keys, keys(var.settings))) == 0
      error_message = "settings is missing: ${join(", ", sort(setsubtract(local.settings_keys, keys(var.settings))))}"
    }
    precondition {
      condition = alltrue([for group, keys_ in local.key_lists.derived :
      toset(keys(local.derived[group])) == toset(keys_)])
      error_message = "env-keys.json \"derived\" and local.derived disagree."
    }
    precondition {
      condition     = length(setsubtract(keys(var.settings), local.settings_keys)) == 0
      error_message = "settings has unknown keys (or keys derived by the module): ${join(", ", sort(setsubtract(keys(var.settings), local.settings_keys)))}"
    }
  }
}

module "network" {
  source             = "../network"
  name               = local.name
  region             = var.region
  cidr_block         = var.cidr_block
  nat_gateway_count  = var.sizes.nat_gateway_count
  log_retention_days = local.log_days
}

module "ecr" {
  source      = "../ecr"
  name        = "nile-marketplace"
  keep_images = 30
}

# The api, worker and migrate tasks share one security group: the data stores admit only it.
resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "api, worker and migrate tasks"
  vpc_id      = module.network.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = module.alb.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = local.api_port
  to_port                      = local.api_port
  description                  = "ALB to api"
}

# Kashier, Mailjet, ECR, Secrets Manager and CloudWatch Logs are HTTPS endpoints on the internet,
# reached through the NAT gateway (fixed egress IPs, K-7).
#trivy:ignore:AVD-AWS-0104
resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  description       = "HTTPS to providers and AWS APIs"
}

resource "aws_vpc_security_group_egress_rule" "app_to_data" {
  for_each = {
    postgres = { port = 5432, cidr = var.cidr_block }
    redis    = { port = 6379, cidr = var.cidr_block }
    amqps    = { port = 5671, cidr = var.cidr_block }
  }
  security_group_id = aws_security_group.app.id
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr
  description       = "${each.key} inside the VPC"
}

module "alb" {
  source                       = "../alb"
  name                         = local.name
  vpc_id                       = module.network.vpc_id
  public_subnet_ids            = module.network.public_subnet_ids
  app_security_group_id        = aws_security_group.app.id
  target_port                  = local.api_port
  domain_name                  = var.domain_name
  route53_zone_id              = var.route53_zone_id
  deletion_protection          = var.sizes.deletion_protection
  deregistration_delay_seconds = ceil(tonumber(var.settings.SHUTDOWN_TIMEOUT_MS) / 1000) + 5
}

module "rds" {
  source                   = "../rds"
  name                     = local.name
  vpc_id                   = module.network.vpc_id
  subnet_ids               = module.network.private_subnet_ids
  app_security_group_id    = aws_security_group.app.id
  engine_version           = "18"
  instance_class           = var.sizes.rds_instance_class
  multi_az                 = var.sizes.rds_multi_az
  allocated_storage_gb     = var.sizes.rds_storage_gb
  max_allocated_storage_gb = var.sizes.rds_max_storage_gb
  database_name            = "nile"
  username                 = "nile"
  backup_retention_days    = var.sizes.rds_backup_retention_days
  deletion_protection      = var.sizes.deletion_protection
  log_min_duration_ms      = 500
}

module "redis" {
  source                = "../elasticache"
  name                  = local.name
  vpc_id                = module.network.vpc_id
  subnet_ids            = module.network.private_subnet_ids
  app_security_group_id = aws_security_group.app.id
  engine_version        = "7.1"
  node_type             = var.sizes.redis_node_type
}

module "mq" {
  source                = "../amazon-mq"
  name                  = local.name
  vpc_id                = module.network.vpc_id
  subnet_ids            = module.network.private_subnet_ids
  app_security_group_id = aws_security_group.app.id
  engine_version        = "4.2"
  instance_type         = var.sizes.mq_instance_type
  username              = "nile"
}

module "secrets" {
  source = "../secrets"
  prefix = "nile/${var.environment_name}"
  generated = {
    DATABASE_URL = module.rds.database_url
    REDIS_URL    = module.redis.redis_url
    RABBITMQ_URL = module.mq.rabbitmq_url
  }
  manual               = local.manual_secrets
  recovery_window_days = var.environment_name == "prod" ? 30 : 7
}

resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = var.sizes.container_insights ? "enabled" : "disabled"
  }
}

module "api" {
  source               = "../ecs-service"
  name                 = "api"
  environment_name     = var.environment_name
  region               = var.region
  cluster_arn          = aws_ecs_cluster.this.arn
  cluster_name         = aws_ecs_cluster.this.name
  image                = local.image
  command              = ["node", "dist/server.js"]
  cpu                  = var.sizes.api_cpu
  memory               = var.sizes.api_memory
  environment          = local.pick.api
  secrets              = { for key in local.secret_names.api : key => module.secrets.arns[key] }
  container_port       = local.api_port
  run_as_service       = true
  desired_count        = var.sizes.api_desired_count
  subnet_ids           = module.network.private_subnet_ids
  security_group_ids   = [aws_security_group.app.id]
  target_group_arn     = module.alb.target_group_arn
  autoscaling          = var.sizes.api_autoscaling
  stop_timeout_seconds = ceil(tonumber(var.settings.SHUTDOWN_TIMEOUT_MS) / 1000) + 5
  log_retention_days   = local.log_days
  depends_on           = [terraform_data.settings_check]
}

module "worker" {
  source               = "../ecs-service"
  name                 = "worker"
  environment_name     = var.environment_name
  region               = var.region
  cluster_arn          = aws_ecs_cluster.this.arn
  cluster_name         = aws_ecs_cluster.this.name
  image                = local.image
  command              = ["node", "dist/worker.js"]
  cpu                  = var.sizes.worker_cpu
  memory               = var.sizes.worker_memory
  environment          = local.pick.worker
  secrets              = { for key in local.secret_names.worker : key => module.secrets.arns[key] }
  container_port       = null
  run_as_service       = true
  desired_count        = var.sizes.worker_desired_count
  subnet_ids           = module.network.private_subnet_ids
  security_group_ids   = [aws_security_group.app.id]
  target_group_arn     = null
  autoscaling          = null
  stop_timeout_seconds = ceil(tonumber(var.settings.SHUTDOWN_TIMEOUT_MS) / 1000) + 5
  log_retention_days   = local.log_days
  depends_on           = [terraform_data.settings_check]
}

# Run once per deploy before the services roll (`node dist/migrate.js latest`), and for the first
# admin (`node dist/seed-admin.js --email …`, docs/runbooks): a task definition, no service.
module "migrate" {
  source               = "../ecs-service"
  name                 = "migrate"
  environment_name     = var.environment_name
  region               = var.region
  cluster_arn          = aws_ecs_cluster.this.arn
  cluster_name         = aws_ecs_cluster.this.name
  image                = local.image
  command              = ["node", "dist/migrate.js", "latest"]
  cpu                  = 256
  memory               = 512
  environment          = local.pick.migrate
  secrets              = { for key in local.secret_names.migrate : key => module.secrets.arns[key] }
  container_port       = null
  run_as_service       = false
  desired_count        = 0
  subnet_ids           = module.network.private_subnet_ids
  security_group_ids   = [aws_security_group.app.id]
  target_group_arn     = null
  autoscaling          = null
  stop_timeout_seconds = 30
  log_retention_days   = local.log_days
  depends_on           = [terraform_data.settings_check]
}

module "alarms" {
  source                           = "../alarms"
  environment_name                 = var.environment_name
  alert_email                      = var.alert_email
  app_log_group_names              = [module.api.log_group_name, module.worker.log_group_name]
  error_log_threshold              = var.sizes.error_log_alarm_threshold
  alb_arn_suffix                   = module.alb.arn_suffix
  target_group_arn_suffix          = module.alb.target_group_arn_suffix
  alb_5xx_threshold                = var.sizes.alb_5xx_alarm_threshold
  rds_instance_id                  = module.rds.instance_id
  rds_cpu_threshold_percent        = 80
  rds_free_storage_threshold_bytes = 5 * 1024 * 1024 * 1024
}
