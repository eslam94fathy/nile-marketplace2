output "state_bucket" {
  description = "Put into envs/<env>/backend.hcl."
  value       = aws_s3_bucket.state.bucket
}

output "state_kms_key_arn" {
  description = "Put into envs/<env>/backend.hcl (kms_key_id)."
  value       = aws_kms_key.state.arn
}

output "plan_role_arn" {
  description = "GitHub variable AWS_PLAN_ROLE_ARN (infra.yml, from P9)."
  value       = aws_iam_role.plan.arn
}

output "deploy_role_arn" {
  description = "GitHub variable AWS_DEPLOY_ROLE_ARN (deploy.yml, from P9)."
  value       = aws_iam_role.deploy.arn
}
