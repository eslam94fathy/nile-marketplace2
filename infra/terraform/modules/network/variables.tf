variable "name" {
  description = "Prefix for every resource, e.g. nile-staging."
  type        = string
}

variable "region" {
  type = string
}

variable "cidr_block" {
  description = "A /16 for the VPC."
  type        = string
}

variable "nat_gateway_count" {
  description = "1 (staging) or 2 (prod, one per AZ)."
  type        = number
  validation {
    condition     = contains([1, 2], var.nat_gateway_count)
    error_message = "nat_gateway_count must be 1 or 2."
  }
}

variable "log_retention_days" {
  type = number
}
