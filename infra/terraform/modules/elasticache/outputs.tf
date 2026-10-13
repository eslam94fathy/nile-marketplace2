output "redis_url" {
  description = "Goes into the REDIS_URL secret only."
  value       = "rediss://:${random_password.auth.result}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
  sensitive   = true
}

output "replication_group_id" {
  value = aws_elasticache_replication_group.this.id
}
