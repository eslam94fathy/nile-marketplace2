export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailMessage {
  to: EmailAddress;
  subject: string;
  text: string;
  html: string;
  /** Our reference (e.g. the source event id), echoed by the provider for tracing. */
  customId?: string;
}

export interface SendResult {
  providerMessageId: string | null;
}

/**
 * `permanent: true` = retrying cannot help (e.g. invalid recipient): the caller records the failure.
 * `permanent: false` = transient (timeout, 429, 5xx, auth/config): the caller retries.
 */
export class EmailSendError extends Error {
  override readonly name = 'EmailSendError';

  constructor(
    message: string,
    readonly permanent: boolean,
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface IEmailSender {
  send(message: EmailMessage): Promise<SendResult>;
}
