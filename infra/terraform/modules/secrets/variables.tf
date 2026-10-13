variable "prefix" {
  description = "Secret name prefix, e.g. nile/staging."
  type        = string
}

variable "generated" {
  description = "Env key → value Terraform knows (DATABASE_URL, REDIS_URL, RABBITMQ_URL)."
  type        = map(string)
  sensitive   = true
}

variable "manual" {
  description = "Env keys created empty and filled by hand."
  type        = list(string)
}

variable "recovery_window_days" {
  description = "Days a deleted secret can still be restored (7–30)."
  type        = number
}
