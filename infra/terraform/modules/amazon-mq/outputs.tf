output "rabbitmq_url" {
  description = "Goes into the RABBITMQ_URL secret only."
  value = format(
    "amqps://%s:%s@%s",
    var.username,
    random_password.app.result,
    trimprefix(aws_mq_broker.this.instances[0].endpoints[0], "amqps://"),
  )
  sensitive = true
}

output "broker_id" {
  value = aws_mq_broker.this.id
}
