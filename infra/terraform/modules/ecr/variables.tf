variable "name" {
  type = string
}

variable "keep_images" {
  description = "How many images to keep for rollbacks."
  type        = number
}
