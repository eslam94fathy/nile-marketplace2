variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets."
  type        = list(string)
}

variable "app_security_group_id" {
  type = string
}

variable "engine_version" {
  description = "Redis OSS 7.x, the engine local dev and tests use (P8-Q7)."
  type        = string
}

variable "node_type" {
  type = string
}
