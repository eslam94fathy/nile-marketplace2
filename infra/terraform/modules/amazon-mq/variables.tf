variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets; a single-instance broker uses the first."
  type        = list(string)
}

variable "app_security_group_id" {
  type = string
}

variable "engine_version" {
  description = "4.2 (P8-Q8); Amazon MQ manages the patch version."
  type        = string
}

variable "instance_type" {
  description = "RabbitMQ 4.2 runs only on mq.m7g.* (P8-Q8)."
  type        = string
}

variable "username" {
  type = string
}
