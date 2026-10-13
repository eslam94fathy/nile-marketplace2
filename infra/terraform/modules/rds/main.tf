# RDS PostgreSQL 18 (architecture §13.1, P8-Q7): private, encrypted, TLS forced, PITR backups.
# The password is generated here and lives only in the encrypted, access-restricted state and in
# the DATABASE_URL secret (P8-Q10).

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

resource "random_password" "master" {
  length  = 40
  special = false # goes into a URL; 40 alphanumerics are plenty
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name        = "${var.name}-db"
  description = "Postgres, from the app tasks only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "from_app" {
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.app_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "app tasks"
}

resource "aws_db_parameter_group" "this" {
  name   = var.name
  family = "postgres18"
  # The app connects with DB_SSL=true and verifies the certificate (P8-Q9); plain TCP is refused.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  # Queries slower than this show up in the Postgres log (load test, P8-Q13).
  parameter {
    name  = "log_min_duration_statement"
    value = tostring(var.log_min_duration_ms)
  }
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.engine_version
  # Minor versions are AWS-managed inside the maintenance window.
  auto_minor_version_upgrade = true
  instance_class             = var.instance_class
  multi_az                   = var.multi_az

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.database_name
  username = var.username
  password = random_password.master.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false

  backup_retention_period   = var.backup_retention_days
  backup_window             = "01:00-02:00"
  maintenance_window        = "sun:02:30-sun:03:30"
  copy_tags_to_snapshot     = true
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "${var.name}-final" : null

  performance_insights_enabled        = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  iam_database_authentication_enabled = false
}
