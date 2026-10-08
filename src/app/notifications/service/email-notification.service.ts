import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type EventEnvelope,
  type NotificationEmailRequestedPayload,
  PermanentEventError,
  type UserRoleValue,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { type ISecretBox } from '../../../pkg/crypto';
import { EmailSendError, type IEmailSender } from '../../../pkg/email';
import { LOG_ERROR_MAX_LENGTH, REDACTED } from '../constants';
import { EmailTemplateName, NotificationStatus } from '../enums';
import { type NotificationLogRepository } from '../repository/notification-log.repository';
import { renderEmail, type RenderRequest } from '../templates';

/** What happened outside the transaction, recorded inside it. */
export type SendOutcome =
  | { kind: 'already-logged' }
  | { kind: 'sent'; providerMessageId: string | null }
  | { kind: 'failed'; error: string };

const TEMPLATES: ReadonlySet<string> = new Set(Object.values(EmailTemplateName));
const ROLES: ReadonlySet<string> = new Set(['customer', 'seller', 'admin', 'delivery_agent']);
const OTP_PATTERN = /^\d{6}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * UC-NO-1 (spec 13): decrypt the secret variables, render, send, record the final outcome.
 * The OTP / invite link is never logged or stored, including inside provider error text.
 */
@injectable()
export class EmailNotificationService {
  constructor(
    @inject(TOKENS.NotificationLogRepository) private readonly log: NotificationLogRepository,
    @inject(TOKENS.EmailSender) private readonly sender: IEmailSender,
    @inject(TOKENS.SecretBox) private readonly secretBox: ISecretBox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  /**
   * Outside any transaction (an HTTP call). Throws PermanentEventError (→ DLQ) for a payload that can
   * never be sent, and rethrows transient send failures (→ retry queue).
   */
  async send(envelope: EventEnvelope): Promise<SendOutcome> {
    if (await this.log.existsForEvent(envelope.eventId)) return { kind: 'already-logged' };

    const payload = parsePayload(envelope.payload);
    const secrets = this.openSecrets(payload, envelope.eventId);
    const email = renderEmail(toRenderRequest(payload, secrets));
    try {
      const result = await this.sender.send({
        to: { email: payload.toEmail },
        subject: email.subject,
        text: email.text,
        html: email.html,
        customId: envelope.eventId,
      });
      return { kind: 'sent', providerMessageId: result.providerMessageId };
    } catch (error) {
      const secretValues = Object.values(secrets);
      if (error instanceof EmailSendError && error.permanent) {
        return { kind: 'failed', error: redact(error.message, secretValues) };
      }
      // Transient: the consumer host logs it and retries. Keep only a redacted message.
      throw new Error(redact(error instanceof Error ? error.message : 'email send failed', secretValues));
    }
  }

  /** Inside the consumer transaction, together with the `processed_events` row. */
  async record(envelope: EventEnvelope, outcome: SendOutcome, trx: DbTransaction): Promise<void> {
    if (outcome.kind === 'already-logged') return;
    const payload = parsePayload(envelope.payload);
    const error = outcome.kind === 'failed' ? outcome.error.slice(0, LOG_ERROR_MAX_LENGTH) : null;
    await this.log.insert(
      {
        userId: payload.userId,
        template: payload.template,
        toEmail: payload.toEmail,
        status: outcome.kind === 'failed' ? NotificationStatus.FAILED : NotificationStatus.SENT,
        providerMessageId: outcome.kind === 'sent' ? outcome.providerMessageId : null,
        error,
        sourceEventId: envelope.eventId,
      },
      trx,
    );
    if (error !== null) {
      this.logger.error('email could not be delivered', {
        event: 'EMAIL_SEND_FAILED',
        eventId: envelope.eventId,
        userId: payload.userId,
        template: payload.template,
        reason: error,
      });
    }
  }

  private openSecrets(payload: NotificationEmailRequestedPayload, eventId: string): Record<string, unknown> {
    try {
      const opened: unknown = JSON.parse(
        this.secretBox.open(payload.encryptedSecrets, `${payload.userId}:${payload.template}`),
      );
      if (!isRecord(opened)) throw new Error('secrets are not an object');
      return opened;
    } catch {
      // No payload and no cause in the log: either could carry secret material.
      this.logger.error('secret variables could not be decrypted', {
        event: 'SECRET_DECRYPT_FAILED',
        eventId,
        userId: payload.userId,
        template: payload.template,
      });
      throw new PermanentEventError('SECRET_DECRYPT_FAILED');
    }
  }
}

/** The broker payload is untrusted input: anything malformed can never be sent (→ DLQ). */
function parsePayload(raw: unknown): NotificationEmailRequestedPayload {
  if (
    !isRecord(raw) ||
    typeof raw.template !== 'string' ||
    !TEMPLATES.has(raw.template) ||
    typeof raw.userId !== 'string' ||
    typeof raw.toEmail !== 'string' ||
    raw.toEmail.length === 0 ||
    !isRecord(raw.variables) ||
    typeof raw.encryptedSecrets !== 'string'
  ) {
    throw new PermanentEventError('malformed notification.email_requested payload');
  }
  return raw as unknown as NotificationEmailRequestedPayload;
}

function toRenderRequest(
  payload: NotificationEmailRequestedPayload,
  secrets: Record<string, unknown>,
): RenderRequest {
  const variables = payload.variables as Record<string, unknown>;
  if (payload.template === EmailTemplateName.ACCOUNT_INVITE) {
    const { role, expiresAt } = variables;
    const { inviteUrl } = secrets;
    if (
      typeof inviteUrl !== 'string' ||
      !/^https?:\/\//.test(inviteUrl) ||
      typeof role !== 'string' ||
      !ROLES.has(role) ||
      typeof expiresAt !== 'string' ||
      Number.isNaN(Date.parse(expiresAt))
    ) {
      throw new PermanentEventError('malformed account_invite variables');
    }
    return { template: payload.template, variables: { inviteUrl, role: role as UserRoleValue, expiresAt } };
  }
  const { expiresInMinutes } = variables;
  const { otp } = secrets;
  if (typeof otp !== 'string' || !OTP_PATTERN.test(otp) || typeof expiresInMinutes !== 'number') {
    throw new PermanentEventError(`malformed ${payload.template} variables`);
  }
  return { template: payload.template, variables: { otp, expiresInMinutes } };
}

/** Provider error text could echo message content: strip every secret value from it. */
function redact(text: string, secrets: readonly unknown[]): string {
  return secrets.reduce<string>(
    (out, secret) =>
      typeof secret === 'string' && secret.length > 0 ? out.split(secret).join(REDACTED) : out,
    text,
  );
}
