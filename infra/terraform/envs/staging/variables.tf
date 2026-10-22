# Values only known at P9 (the user's domain, addresses, key ids). terraform.tfvars.example lists them.

variable "region" {
  description = "eu-central-1 (SD-3d)."
  type        = string
}

variable "domain_name" {
  description = "api.staging.<domain> (P8-Q11)."
  type        = string
}

variable "route53_zone_id" {
  description = "Hosted zone of domain_name; null when DNS is elsewhere."
  type        = string
  nullable    = true
}

variable "alert_email" {
  type = string
}

variable "image_tag" {
  description = "The first image pushed to ECR (git SHA); deploy.yml takes over afterwards."
  type        = string
}

variable "invite_url_base" {
  description = "https app link; a placeholder on the same domain is fine for staging (P8-Q11)."
  type        = string
}

variable "media_public_base_url" {
  description = "https://media.<domain> of staging (the CDN, A-8); set when the cdn module lands (R2-P1). No trailing slash."
  type        = string
}

variable "kashier_redirect_url" {
  description = "https app link Kashier sends the customer back to (P5-Q14)."
  type        = string
}

variable "mailjet_from_email" {
  description = "The verified Mailjet sender (P1-Q8)."
  type        = string
}

variable "jwt_active_kid" {
  description = "kid of the key in the JWT_PRIVATE_KEY secret; must be a key of JWT_PUBLIC_KEYS (P1-Q5)."
  type        = string
}

variable "secrets_encryption_active_key_id" {
  description = "Active key id of the SECRETS_ENCRYPTION_KEYS secret."
  type        = string
}

variable "vapid_public_key" {
  description = "Web Push VAPID public key (base64url, 87 chars) of staging; its private key goes into the VAPID_PRIVATE_KEY secret by hand (docs/runbooks/secrets.md, R2-Q7)."
  type        = string
}

variable "vapid_subject" {
  description = "Web Push contact the push services may use: mailto:<ops address> or an https URL (RFC 8292)."
  type        = string
}
