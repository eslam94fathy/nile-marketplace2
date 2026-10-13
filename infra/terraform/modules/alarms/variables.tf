variable "environment_name" {
  type = string
}

variable "alert_email" {
  description = "Receives every alarm (confirms the SNS subscription once)."
  type        = string
}

variable "app_log_group_names" {
  description = "The api and worker log groups."
  type        = list(string)
}

variable "error_log_threshold" {
  description = "error / fatal lines in 5 minutes that raise the alarm."
  type        = number
}

variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffix" {
  type = string
}

variable "alb_5xx_threshold" {
  description = "Target 5xx answers in 5 minutes."
  type        = number
}

variable "rds_instance_id" {
  type = string
}

variable "rds_cpu_threshold_percent" {
  type = number
}

variable "rds_free_storage_threshold_bytes" {
  type = number
}
