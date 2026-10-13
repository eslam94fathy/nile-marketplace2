# Amazon MQ for RabbitMQ 4.2, single instance (architecture §13.1, P8-Q8): private, reached with
# `amqps://` on 5671 (P8-Q9). Our durable classic queues with TTL dead-letter retries run unchanged.

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

resource "random_password" "app" {
  length  = 40
  special = false # goes into a URL
}

resource "aws_security_group" "this" {
  name        = "${var.name}-mq"
  description = "RabbitMQ (AMQPS), from the app tasks only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "from_app" {
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.app_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5671
  to_port                      = 5671
  description                  = "app tasks (AMQPS)"
}

resource "aws_mq_broker" "this" {
  broker_name                = var.name
  engine_type                = "RabbitMQ"
  engine_version             = var.engine_version
  host_instance_type         = var.instance_type
  deployment_mode            = "SINGLE_INSTANCE"
  auto_minor_version_upgrade = true
  publicly_accessible        = false
  subnet_ids                 = [var.subnet_ids[0]]
  security_groups            = [aws_security_group.this.id]
  apply_immediately          = false

  user {
    username = var.username
    password = random_password.app.result
  }

  logs {
    general = true
  }

  maintenance_window_start_time {
    day_of_week = "SUNDAY"
    time_of_day = "04:30"
    time_zone   = "UTC"
  }
}
