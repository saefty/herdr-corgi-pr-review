resource "aws_sqs_queue" "mail" {
  name = "bookshelf-mail"
}

resource "aws_cloudwatch_event_rule" "due_reminders" {
  name                = "bookshelf-due-reminders"
  schedule_expression = "cron(0 8 * * ? *)"
}
