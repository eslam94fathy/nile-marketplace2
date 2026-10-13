output "target_group_arn" {
  value = aws_lb_target_group.api.arn
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "dns_name" {
  description = "CNAME / alias target when DNS is not in Route 53."
  value       = aws_lb.this.dns_name
}

output "arn_suffix" {
  description = "For CloudWatch alarms."
  value       = aws_lb.this.arn_suffix
}

output "target_group_arn_suffix" {
  value = aws_lb_target_group.api.arn_suffix
}

output "certificate_validation_records" {
  description = "Add these at the DNS provider when route53_zone_id is null."
  value = [for option in aws_acm_certificate.this.domain_validation_options : {
    name  = option.resource_record_name
    type  = option.resource_record_type
    value = option.resource_record_value
  }]
}
