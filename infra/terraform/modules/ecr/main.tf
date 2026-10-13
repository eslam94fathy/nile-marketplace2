# The one image repository: api, worker and migrate run the same image (architecture §13),
# tagged with the git SHA by deploy.yml (P8-Q12). Tags are immutable, so a SHA always means one image.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.64.0, < 7.0.0"
    }
  }
}

resource "aws_ecr_repository" "this" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
  }
}

# Keep the last N images (rollbacks pick from these, docs/runbooks); untagged layers go after a day.
resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last ${var.keep_images} images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = var.keep_images }
        action       = { type = "expire" }
      },
    ]
  })
}
