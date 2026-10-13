# Alerting on top of the logs (SD-4 stays: no metrics endpoint or error-tracking service) and on a
# few AWS metrics (architecture §13.1, P8-Q15). Everything goes to one SNS topic with an email
# subscription; the address confirms the subscription once.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.64.0, < 7.0.0"
    }
  }
}

locals {
  namespace = "Nile/${var.environment_name}"
  # The app logs one JSON object per line (CLAUDE.md §9.2).
  log_metrics = {
    errors        = { pattern = "{ ($.level = \"error\") || ($.level = \"fatal\") }", threshold = var.error_log_threshold }
    dead_lettered = { pattern = "{ $.event = \"MQ_DEAD_LETTERED\" }", threshold = 1 }
  }
  log_filters = merge([
    for group in var.app_log_group_names : {
      for metric, spec in local.log_metrics : "${group}|${metric}" => { group = group, metric = metric, pattern = spec.pattern }
    }
  ]...)
}

# Alarm text only, no business data: the AWS-managed key is enough, and a customer key would need a
# key policy for CloudWatch to publish.
#trivy:ignore:AVD-AWS-0136
resource "aws_sns_topic" "alerts" {
  name              = "nile-${var.environment_name}-alerts"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_log_metric_filter" "app" {
  for_each       = local.log_filters
  name           = replace("${each.value.metric}-${each.value.group}", "/", "-")
  log_group_name = each.value.group
  pattern        = each.value.pattern
  metric_transformation {
    name          = each.value.metric
    namespace     = local.namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "app_logs" {
  for_each            = local.log_metrics
  alarm_name          = "nile-${var.environment_name}-${each.key}"
  alarm_description   = "Log lines matching ${each.value.pattern} (api and worker)"
  namespace           = local.namespace
  metric_name         = each.key
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.app]
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "nile-${var.environment_name}-alb-5xx"
  alarm_description   = "5xx answered by the api targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.alb_5xx_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  alarm_name          = "nile-${var.environment_name}-unhealthy-targets"
  alarm_description   = "api tasks failing the load balancer health check"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "nile-${var.environment_name}-rds-cpu"
  alarm_description   = "Postgres CPU high for 15 minutes"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.rds_instance_id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.rds_cpu_threshold_percent
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "nile-${var.environment_name}-rds-free-storage"
  alarm_description   = "Postgres free storage low"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.rds_instance_id }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.rds_free_storage_threshold_bytes
  comparison_operator = "LessThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
