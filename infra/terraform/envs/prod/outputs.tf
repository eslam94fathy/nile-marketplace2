output "nat_public_ips" {
  description = "Allow-list these in Kashier (K-7)."
  value       = module.environment.nat_public_ips
}

output "alb_dns_name" {
  value = module.environment.alb_dns_name
}

output "certificate_validation_records" {
  value = module.environment.certificate_validation_records
}

output "ecr_repository_url" {
  value = module.environment.ecr_repository_url
}

output "deploy" {
  description = "Copy into the GitHub environment variables of `production` (deploy.yml)."
  value       = module.environment.deploy
}
