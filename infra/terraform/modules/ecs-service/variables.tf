variable "name" {
  description = "api, worker or migrate."
  type        = string
}

variable "environment_name" {
  description = "staging or prod (names and log groups)."
  type        = string
}

variable "region" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "image" {
  description = "The image to start with; deploy.yml replaces it on every deploy."
  type        = string
}

variable "command" {
  description = "e.g. [\"node\", \"dist/worker.js\"]."
  type        = list(string)
}

variable "cpu" {
  type = number
}

variable "memory" {
  type = number
}

variable "environment" {
  description = "Every non-secret env key of the process, explicitly (CLAUDE.md §4)."
  type        = map(string)
}

variable "secrets" {
  description = "Env key → Secrets Manager ARN."
  type        = map(string)
}

variable "container_port" {
  description = "The api's PORT; null for processes without HTTP."
  type        = number
  nullable    = true
}

variable "run_as_service" {
  description = "false for the migrate task definition (run once per deploy by deploy.yml)."
  type        = bool
}

variable "desired_count" {
  type = number
}

variable "subnet_ids" {
  description = "Private subnets."
  type        = list(string)
}

variable "security_group_ids" {
  type = list(string)
}

variable "target_group_arn" {
  description = "The ALB target group (api only); null otherwise."
  type        = string
  nullable    = true
}

variable "autoscaling" {
  description = "Target tracking on CPU (prod api); null for a fixed count."
  type = object({
    min                = number
    max                = number
    cpu_target_percent = number
  })
  nullable = true
}

variable "stop_timeout_seconds" {
  description = "SIGTERM → SIGKILL; above the app's SHUTDOWN_TIMEOUT_MS so graceful shutdown completes."
  type        = number
}

variable "log_retention_days" {
  type = number
}
