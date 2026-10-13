# One container service on Fargate (architecture §13, §13.1): used for the api and the worker, and
# (with desired_count = 0 and no service) for the migrate task definition. Same image for all three.
#
# deploy.yml owns the image: it registers a new task definition revision from the latest one with the
# new image tag and rolls the service (P8-Q12). Terraform therefore ignores the service's
# task_definition, and a change here (env, size) reaches the tasks with the next deploy.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.64.0, < 7.0.0"
    }
  }
}

locals {
  container = {
    name      = var.name
    image     = var.image
    essential = true
    command   = var.command
    # Every non-secret key is explicit (no defaults, CLAUDE.md §4); secrets come by ARN (P8-Q10).
    environment = [for key in sort(keys(var.environment)) : { name = key, value = var.environment[key] }]
    secrets     = [for key in sort(keys(var.secrets)) : { name = key, valueFrom = var.secrets[key] }]
    portMappings = var.container_port == null ? [] : [
      { containerPort = var.container_port, protocol = "tcp" },
    ]
    # The image's HEALTHCHECK probes /health/live; the worker serves no HTTP, so it has none.
    healthCheck = var.container_port == null ? null : {
      command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:${var.container_port}/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
    readonlyRootFilesystem = true
    stopTimeout            = var.stop_timeout_seconds
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = var.name
      }
    }
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/nile/${var.environment_name}/${var.name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "assume_ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: what ECS needs to start the task (pull the image, read the secrets, write logs).
resource "aws_iam_role" "execution" {
  name               = "nile-${var.environment_name}-${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(var.secrets)
  }
}

resource "aws_iam_role_policy" "read_secrets" {
  count  = length(var.secrets) > 0 ? 1 : 0
  name   = "read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secrets[0].json
}

# Task role: the app calls no AWS API, so it has no permissions.
resource "aws_iam_role" "task" {
  name               = "nile-${var.environment_name}-${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

resource "aws_ecs_task_definition" "this" {
  family                   = "nile-${var.environment_name}-${var.name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([local.container])
}

resource "aws_ecs_service" "this" {
  count                  = var.run_as_service ? 1 : 0
  name                   = var.name
  cluster                = var.cluster_arn
  task_definition        = aws_ecs_task_definition.this.arn
  desired_count          = var.desired_count
  launch_type            = "FARGATE"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.target_group_arn == null ? [] : [var.target_group_arn]
    content {
      target_group_arn = load_balancer.value
      container_name   = var.name
      container_port   = var.container_port
    }
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    # deploy.yml registers new revisions; autoscaling changes desired_count.
    ignore_changes = [task_definition, desired_count]
  }
}

resource "aws_appautoscaling_target" "this" {
  count              = var.run_as_service && var.autoscaling != null ? 1 : 0
  service_namespace  = "ecs"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.autoscaling.min
  max_capacity       = var.autoscaling.max
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = var.run_as_service && var.autoscaling != null ? 1 : 0
  name               = "${var.name}-cpu"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value = var.autoscaling.cpu_target_percent
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
