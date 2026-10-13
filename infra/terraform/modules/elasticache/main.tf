# ElastiCache Redis OSS (architecture §13.1, P8-Q7): one node (Redis is not a source of truth,
# architecture §8), TLS in transit and an AUTH token, so the app connects with `rediss://` (P8-Q9).

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.64.0, < 7.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.8.1, < 4.0.0"
    }
  }
}

resource "random_password" "auth" {
  length  = 48
  special = false # goes into a URL
}

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name        = "${var.name}-redis"
  description = "Redis, from the app tasks only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "from_app" {
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.app_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  description                  = "app tasks"
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = var.name
  description          = "Rate limits, idempotency keys, cache (not a source of truth)"
  engine               = "redis"
  engine_version       = var.engine_version
  node_type            = var.node_type
  num_cache_clusters   = 1
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.this.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = random_password.auth.result

  auto_minor_version_upgrade = true
  maintenance_window         = "sun:03:30-sun:04:30"
  snapshot_retention_limit   = 0 # nothing to restore: it holds no business data
  apply_immediately          = false
}
