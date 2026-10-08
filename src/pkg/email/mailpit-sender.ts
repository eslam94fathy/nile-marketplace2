import {
  type EmailAddress,
  type EmailMessage,
  type IEmailSender,
  type SendResult,
} from './email-sender.interface';
import { postJson } from './http';

export interface MailpitOptions {
  url: string;
  from: EmailAddress;
  timeoutMs: number;
}

/** Development/test inbox (P1-Q2): Mailpit's HTTP send API, so no SMTP library is needed. */
export class MailpitEmailSender implements IEmailSender {
  constructor(private readonly options: MailpitOptions) {}

  async send(message: EmailMessage): Promise<SendResult> {
    const body = {
      From: { Email: this.options.from.email, Name: this.options.from.name ?? '' },
      To: [{ Email: message.to.email, Name: message.to.name ?? '' }],
      Subject: message.subject,
      Text: message.text,
      HTML: message.html,
      ...(message.customId ? { Headers: { 'X-Nile-Ref': message.customId } } : {}),
    };
    const response = (await postJson(
      `${this.options.url.replace(/\/$/, '')}/api/v1/send`,
      body,
      {},
      this.options.timeoutMs,
    )) as { ID?: string };
    return { providerMessageId: response.ID ?? null };
  }
}
