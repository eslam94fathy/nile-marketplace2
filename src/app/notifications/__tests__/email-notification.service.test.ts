import { randomBytes, randomUUID } from 'node:crypto';
import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type EventEnvelope, PermanentEventError } from '../../../lib/events';
import { type ILogger, type LogFields } from '../../../lib/logger';
import { AesGcmSecretBox } from '../../../pkg/crypto';
import { EmailSendError, type EmailMessage } from '../../../pkg/email';
import { EmailNotificationService, type SendOutcome } from '../service/email-notification.service';

const TRX = { isTransaction: true } as unknown as DbTransaction;
const OTP = '042917';

class SpyLogger implements ILogger {
  readonly entries: { level: string; message: string; fields?: LogFields }[] = [];
  fatal = (message: string, fields?: LogFields) => this.entries.push({ level: 'fatal', message, fields });
  error = (message: string, fields?: LogFields) => this.entries.push({ level: 'error', message, fields });
  warn = (message: string, fields?: LogFields) => this.entries.push({ level: 'warn', message, fields });
  info = (message: string, fields?: LogFields) => this.entries.push({ level: 'info', message, fields });
  debug = (message: string, fields?: LogFields) => this.entries.push({ level: 'debug', message, fields });
  child = () => this;
}

function setup() {
  const secretBox = new AesGcmSecretBox({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
  const log = {
    existsForEvent: vi.fn(() => Promise.resolve(false)),
    insert: vi.fn((_entry: unknown, _trx: DbTransaction) => Promise.resolve(true)),
  };
  const sender = {
    send: vi.fn((_message: EmailMessage) => Promise.resolve({ providerMessageId: 'mj-1' })),
  };
  const logger = new SpyLogger();
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.NotificationLogRepository, { useValue: log });
  container.register(TOKENS.EmailSender, { useValue: sender });
  container.register(TOKENS.SecretBox, { useValue: secretBox });
  container.register(TOKENS.Logger, { useValue: logger });

  const userId = randomUUID();
  const envelope = (payload: Record<string, unknown> = {}): EventEnvelope => ({
    eventId: randomUUID(),
    eventType: 'notification.email_requested',
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: null,
    aggregateType: 'user',
    aggregateId: userId,
    payload: {
      template: 'password_reset',
      userId,
      toEmail: 'a@x.io',
      variables: { expiresInMinutes: 10 },
      encryptedSecrets: secretBox.seal(JSON.stringify({ otp: OTP }), `${userId}:password_reset`),
      ...payload,
    },
  });
  return {
    service: container.resolve(EmailNotificationService),
    log,
    sender,
    logger,
    secretBox,
    envelope,
    userId,
  };
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('notifications EmailNotificationService (UC-NO-1)', () => {
  it('decrypts, renders and sends; records `sent` with the provider id', async () => {
    const { service, sender, log, envelope } = setup();
    const event = envelope();
    const outcome = await service.send(event);
    expect(outcome).toEqual({ kind: 'sent', providerMessageId: 'mj-1' });

    const message = sender.send.mock.calls[0]?.[0];
    expect(message).toMatchObject({
      to: { email: 'a@x.io' },
      subject: 'Reset your Nile password',
      customId: event.eventId,
    });
    expect(message?.text).toContain(OTP);

    await service.record(event, outcome, TRX);
    const row = log.insert.mock.calls[0]?.[0];
    expect(row).toMatchObject({
      status: 'sent',
      providerMessageId: 'mj-1',
      sourceEventId: event.eventId,
      error: null,
    });
    expect(JSON.stringify(row)).not.toContain(OTP);
  });

  it('skips an event that already has a log row (no second email)', async () => {
    const { service, sender, log, envelope } = setup();
    log.existsForEvent.mockResolvedValue(true);
    const event = envelope();
    const outcome = await service.send(event);
    expect(outcome).toEqual({ kind: 'already-logged' });
    expect(sender.send).not.toHaveBeenCalled();
    await service.record(event, outcome, TRX);
    expect(log.insert).not.toHaveBeenCalled();
  });

  it('permanent provider failure: `failed` row + EMAIL_SEND_FAILED, secrets redacted', async () => {
    const { service, sender, log, logger, envelope } = setup();
    sender.send.mockRejectedValue(
      new EmailSendError(`email provider responded 400: bad body ${OTP}`, true, 400),
    );
    const event = envelope();
    const outcome: SendOutcome = await service.send(event);
    expect(outcome.kind).toBe('failed');

    await service.record(event, outcome, TRX);
    const row = log.insert.mock.calls[0]?.[0] as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('[REDACTED]');
    expect(row.error).not.toContain(OTP);
    expect(logger.entries.some((e) => e.fields?.event === 'EMAIL_SEND_FAILED')).toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain(OTP);
  });

  it('transient provider failure: rethrows (retry), redacted, nothing recorded', async () => {
    const { service, sender, envelope } = setup();
    sender.send.mockRejectedValue(new EmailSendError(`email provider responded 503: ${OTP}`, false, 503));
    const error = await rejection(service.send(envelope()));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentEventError);
    expect((error as Error).message).not.toContain(OTP);
  });

  it('a secret that cannot be decrypted: SECRET_DECRYPT_FAILED, permanent, no payload in the log', async () => {
    const { service, sender, logger, envelope, secretBox, userId } = setup();
    // Sealed for another template: the AAD check fails.
    const wrongAad = secretBox.seal(JSON.stringify({ otp: OTP }), `${userId}:email_verification`);
    const error = await rejection(service.send(envelope({ encryptedSecrets: wrongAad })));
    expect(error).toBeInstanceOf(PermanentEventError);
    expect(sender.send).not.toHaveBeenCalled();
    const entry = logger.entries.find((e) => e.fields?.event === 'SECRET_DECRYPT_FAILED');
    expect(entry?.fields).not.toHaveProperty('encryptedSecrets');
    expect(JSON.stringify(logger.entries)).not.toContain(wrongAad);
  });

  it('malformed payloads and variables are permanent errors', async () => {
    const { service, envelope, secretBox, userId } = setup();
    const badInvite = secretBox.seal(
      JSON.stringify({ inviteUrl: 'javascript:alert(1)' }),
      `${userId}:account_invite`,
    );
    for (const payload of [
      { template: 'marketing' },
      { toEmail: '' },
      { variables: null },
      { variables: {} },
      {
        template: 'account_invite',
        variables: { role: 'admin', expiresAt: '2026-01-01T00:00:00Z' },
        encryptedSecrets: badInvite,
      },
    ]) {
      expect(await rejection(service.send(envelope(payload)))).toBeInstanceOf(PermanentEventError);
    }
  });
});
