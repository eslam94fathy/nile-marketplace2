export {
  EmailSendError,
  type EmailAddress,
  type EmailMessage,
  type IEmailSender,
  type SendResult,
} from './email-sender.interface';
export { MailjetEmailSender, MAILJET_API_BASE_URL, type MailjetOptions } from './mailjet-sender';
export { MailpitEmailSender, type MailpitOptions } from './mailpit-sender';
