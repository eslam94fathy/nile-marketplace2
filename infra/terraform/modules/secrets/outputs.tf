output "arns" {
  description = "Env key → secret ARN, for the task definitions' `secrets`."
  value = merge(
    { for key, secret in aws_secretsmanager_secret.generated : key => secret.arn },
    { for key, secret in aws_secretsmanager_secret.manual : key => secret.arn },
  )
}
