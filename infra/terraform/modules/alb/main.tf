# Public entry point (architecture §13.1, P8-Q11): an ALB with an ACM certificate; TLS terminates
# here and traffic to the api stays in the VPC. HTTP only redirects to HTTPS.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.64.0, < 7.0.0"
    }
  }
}

resource "aws_security_group" "this" {
  name        = "${var.name}-alb"
  description = "Public HTTPS (and the HTTP redirect)"
  vpc_id      = var.vpc_id
}

# The public API: the mobile app reaches it from anywhere.
#trivy:ignore:AVD-AWS-0107
resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each          = toset(["0.0.0.0/0", "::/0"])
  security_group_id = aws_security_group.this.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = strcontains(each.key, ":") ? null : each.key
  cidr_ipv6         = strcontains(each.key, ":") ? each.key : null
  description       = "HTTPS from anywhere"
}

# Only answers with a redirect to HTTPS.
#trivy:ignore:AVD-AWS-0107
resource "aws_vpc_security_group_ingress_rule" "http" {
  for_each          = toset(["0.0.0.0/0", "::/0"])
  security_group_id = aws_security_group.this.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = strcontains(each.key, ":") ? null : each.key
  cidr_ipv6         = strcontains(each.key, ":") ? each.key : null
  description       = "HTTP, redirected to HTTPS"
}

resource "aws_vpc_security_group_egress_rule" "to_api" {
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = var.app_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.target_port
  to_port                      = var.target_port
  description                  = "api tasks"
}

# The ALB is the public entry point by design (architecture §13.1).
#trivy:ignore:AVD-AWS-0053
resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  ip_address_type            = "dualstack"
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.this.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  idle_timeout               = 60
}

resource "aws_lb_target_group" "api" {
  name                 = "${var.name}-api"
  vpc_id               = var.vpc_id
  port                 = var.target_port
  protocol             = "HTTP"
  target_type          = "ip"
  deregistration_delay = var.deregistration_delay_seconds
  # Liveness, not readiness: a Redis or broker outage must not take every task out of the
  # load balancer at once (/health/ready is for operators and the deploy check).
  health_check {
    path                = "/health/live"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records go into Route 53 when the zone is there; otherwise they are an output to
# add at the DNS provider (P8-Q11).
resource "aws_route53_record" "validation" {
  for_each = var.route53_zone_id == null ? {} : {
    for option in aws_acm_certificate.this.domain_validation_options : option.domain_name => option
  }
  zone_id = var.route53_zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = var.route53_zone_id == null ? null : [for record in aws_route53_record.validation : record.fqdn]
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_route53_record" "api" {
  count   = var.route53_zone_id == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
