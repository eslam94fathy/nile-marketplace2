output "database_url" {
  description = "Goes into the DATABASE_URL secret only."
  value       = "postgres://${var.username}:${random_password.master.result}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${var.database_name}"
  sensitive   = true
}

output "instance_id" {
  value = aws_db_instance.this.identifier
}

output "address" {
  value = aws_db_instance.this.address
}
