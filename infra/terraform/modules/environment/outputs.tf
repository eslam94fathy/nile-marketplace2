# What P9 puts into the GitHub environment variables (deploy.yml) and the DNS / Kashier settings.

output "nat_public_ips" {
  description = "Allow-list these in Kashier (K-7)."
  value       = module.network.nat_public_ips
}

output "alb_dns_name" {
  description = "Point the API host here when DNS is not in Route 53."
  value       = module.alb.dns_name
}

output "certificate_validation_records" {
  value = module.alb.certificate_validation_records
}

output "ecr_repository_url" {
  value = module.ecr.repository_url
}

output "deploy" {
  description = "deploy.yml inputs: cluster, services, task definition families and the network for run-task."
  value = {
    cluster            = aws_ecs_cluster.this.name
    api_service        = module.api.service_name
    worker_service     = module.worker.service_name
    api_family         = module.api.task_definition_family
    worker_family      = module.worker.task_definition_family
    migrate_family     = module.migrate.task_definition_family
    private_subnet_ids = module.network.private_subnet_ids
    security_group_id  = aws_security_group.app.id
  }
}

output "alerts_topic_arn" {
  value = module.alarms.topic_arn
}

output "process_environment" {
  description = "Non-secret env per process (no secret values: those are references)."
  value       = { api = module.api.environment, worker = module.worker.environment, migrate = module.migrate.environment }
}

output "process_secret_keys" {
  value = { api = module.api.secret_keys, worker = module.worker.secret_keys, migrate = module.migrate.secret_keys }
}
