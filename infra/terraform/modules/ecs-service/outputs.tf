output "task_definition_family" {
  description = "deploy.yml registers new revisions in this family."
  value       = aws_ecs_task_definition.this.family
}

output "service_name" {
  value = var.run_as_service ? aws_ecs_service.this[0].name : null
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

output "environment" {
  description = "The non-secret env the container gets (tests, review)."
  value       = var.environment
}

output "secret_keys" {
  description = "Names of the env keys that come from Secrets Manager."
  value       = sort(keys(var.secrets))
}
