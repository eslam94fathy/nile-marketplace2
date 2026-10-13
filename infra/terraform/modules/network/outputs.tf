output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "nat_public_ips" {
  description = "Egress IPs to allow-list in Kashier (K-7)."
  value       = aws_eip.nat[*].public_ip
}
