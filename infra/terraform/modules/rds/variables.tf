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
  description = "The api / worker / migrate tasks' security group."
  type        = string
}

variable "engine_version" {
  description = "Major version: 18 (CLAUDE.md §1)."
  type        = string
}

variable "instance_class" {
  type = string
}

variable "multi_az" {
  type = bool
}

variable "allocated_storage_gb" {
  type = number
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
}

variable "database_name" {
  type = string
}

variable "username" {
  type = string
}

variable "backup_retention_days" {
  description = "PITR window: staging 7, prod 14 (architecture §13.1)."
  type        = number
}

variable "deletion_protection" {
  description = "true in prod: also keeps a final snapshot."
  type        = bool
}

variable "log_min_duration_ms" {
  description = "Statements slower than this are logged."
  type        = number
}
