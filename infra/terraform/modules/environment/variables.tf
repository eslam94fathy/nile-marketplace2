variable "environment_name" {
  type = string
  validation {
    condition     = contains(["staging", "prod"], var.environment_name)
    error_message = "environment_name must be staging or prod."
  }
}

variable "region" {
  type = string
}

variable "cidr_block" {
  description = "The VPC's /16."
  type        = string
}

variable "domain_name" {
  description = "The API host, e.g. api.staging.<domain> (P8-Q11)."
  type        = string
}

variable "route53_zone_id" {
  description = "Hosted zone of domain_name; null when DNS is elsewhere."
  type        = string
  nullable    = true
}

variable "alert_email" {
  description = "Receives the alarms (P8-Q15)."
  type        = string
}

variable "image_tag" {
  description = "Git SHA of the image the services start with; deploy.yml moves them on afterwards."
  type        = string
}

variable "sizes" {
  description = "Sizes and counts (architecture §13.1, P8-Q7)."
  type = object({
    nat_gateway_count         = number
    log_retention_days        = number
    deletion_protection       = bool
    container_insights        = bool
    rds_instance_class        = string
    rds_multi_az              = bool
    rds_storage_gb            = number
    rds_max_storage_gb        = number
    rds_backup_retention_days = number
    redis_node_type           = string
    mq_instance_type          = string
    api_cpu                   = number
    api_memory                = number
    api_desired_count         = number
    api_autoscaling = object({
      min                = number
      max                = number
      cpu_target_percent = number
    })
    worker_cpu                = number
    worker_memory             = number
    worker_desired_count      = number
    error_log_alarm_threshold = number
    alb_5xx_alarm_threshold   = number
  })
}

variable "settings" {
  description = "Every non-secret env key the processes read (env-keys.json), as strings."
  type        = map(string)
}
