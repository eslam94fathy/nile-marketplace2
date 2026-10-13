variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "app_security_group_id" {
  description = "The api tasks' security group (the only egress target)."
  type        = string
}

variable "target_port" {
  description = "The api container port (PORT)."
  type        = number
}

variable "domain_name" {
  description = "e.g. api.staging.<domain> (P8-Q11)."
  type        = string
}

variable "route53_zone_id" {
  description = "Hosted zone of domain_name; null when DNS is elsewhere (records are then outputs)."
  type        = string
  nullable    = true
}

variable "deletion_protection" {
  type = bool
}

variable "deregistration_delay_seconds" {
  description = "In-flight requests may finish: keep it above the app's SHUTDOWN_TIMEOUT_MS."
  type        = number
}
