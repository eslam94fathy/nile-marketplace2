variable "environment" {
  description = "Which account this is: staging or prod (one bootstrap per account, P8-Q4)."
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "region" {
  description = "AWS region (SD-3d)."
  type        = string
}

variable "github_repository" {
  description = "owner/name of the GitHub repository whose workflows may assume the roles."
  type        = string
}
