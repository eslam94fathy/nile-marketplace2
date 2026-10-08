import {
  type EmailAddress,
  type EmailMessage,
  type IEmailSender,
  type SendResult,
} from './email-sender.interface';
import { postJson } from './http';

export const MAILJET_API_BASE_URL = 'https://api.mailjet.com';

export interface MailjetOptions {
  apiKey: string;
  secretKey: string;
  from: EmailAddress;
  timeoutMs: number;
  /** Overridable for tests only. */
  baseUrl?: string;
}

interface MailjetSendResponse {
  Messages?: { Status?: string; To?: { MessageUUID?: string; MessageID?: number | string }[] }[];
}

/** Mailjet Send API v3.1 (spec 13). Basic auth with the API key pair; one message per call. */
export class MailjetEmailSender implements IEmailSender {
  private readonly authorization: string;

  constructor(private readonly options: MailjetOptions) {
    this.authorization = `Basic ${Buffer.from(`${options.apiKey}:${options.secretKey}`).toString('base64')}`;
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const body = {
      Messages: [
        {
          From: { Email: this.options.from.email, Name: this.options.from.name },
          To: [{ Email: message.to.email, Name: message.to.name }],
          Subject: message.subject,
          TextPart: message.text,
          HTMLPart: message.html,
          ...(message.customId ? { CustomID: message.customId } : {}),
        },
      ],
    };
    const response = (await postJson(
      `${this.options.baseUrl ?? MAILJET_API_BASE_URL}/v3.1/send`,
      body,
      { Authorization: this.authorization },
      this.options.timeoutMs,
    )) as MailjetSendResponse;

    const recipient = response.Messages?.[0]?.To?.[0];
    const id = recipient?.MessageUUID ?? recipient?.MessageID;
    return { providerMessageId: id === undefined ? null : String(id) };
  }
}
