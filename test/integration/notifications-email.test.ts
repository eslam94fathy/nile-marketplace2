import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  createWorkerInfrastructure,
  closeInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { TOKENS } from '../../src/lib/di';
import { EventConsumerHost, OutboxDrainer } from '../../src/lib/events';
import { EmailSendError, type EmailMessage, type IEmailSender } from '../../src/pkg/email';
import { deadLetterQueueName } from '../../src/pkg/messaging';
import { AmqpProbe, waitFor } from '../helpers/amqp-probe';
import { API, identityFixtures, NEW_PASSWORD } from '../helpers/identity';
import { createMemoryLogger, type MemoryLogWriter } from '../helpers/memory-logger';
import { startTestApp, type TestApp } from '../helpers/test-app';

/** In-memory sender (P1-Q2): records messages; can be told to fail for one recipient. */
class FakeEmailSender implements IEmailSender {
  readonly sent: EmailMessage[] = [];
  readonly failures = new Map<string, EmailSendError>();

  send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    const failure = this.failures.get(message.to.email);
    if (failure) return Promise.reject(failure);
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: `fake-${this.sent.length}` });
  }

  to(email: string): EmailMessage[] {
    return this.sent.filter((m) => m.to.email === email);
  }
}

/*
 * Spec 13 UC-NO-1 end to end on real Postgres + RabbitMQ: api request → outbox (no plain OTP)
 * → drain → notifications.email consumer → sender → notification_log; redelivery sends once.
 */
describe('notifications: transactional email pipeline', () => {
  let t: TestApp;
  let worker: WorkerInfrastructure;
  let workerLogs: MemoryLogWriter;
  let drainer: OutboxDrainer;
  let probe: AmqpProbe;
  const sender = new FakeEmailSender();

  const drain = () => drainer.drainOnce();
  const logRows = (userId: string) =>
    t.infra.db
      .knex('notification_log')
      .where({ user_id: userId })
      .select<{ template: string; status: string; error: string | null; source_event_id: string }[]>(
        'template',
        'status',
        'error',
        'source_event_id',
      );

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '10000' } });
    const { logger, writer } = createMemoryLogger();
    workerLogs = writer;
    // Same database, vhost and keys as the api: a worker next to it.
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    const container = createWorkerContainer(worker);
    container.register(TOKENS.EmailSender, { useValue: sender });

    await worker.broker.assertExchange(worker.env.RABBITMQ_EXCHANGE);
    const consumers = new EventConsumerHost(worker.broker, worker.db, logger, worker.env);
    for (const handler of createEventHandlers(container)) await consumers.start(handler);
    drainer = new OutboxDrainer(worker.db.knex, worker.broker, worker.clock, logger, {
      exchange: worker.env.RABBITMQ_EXCHANGE,
      batchSize: worker.env.OUTBOX_BATCH_SIZE,
      maxBackoffMs: worker.env.OUTBOX_MAX_BACKOFF_MS,
    });
    probe = await AmqpProbe.open(t.resources.workerEnv.RABBITMQ_URL);
  });
  afterAll(async () => {
    await probe.close();
    await closeInfrastructure(worker);
    await t.close();
  });

  it('forgot password: the email carries the OTP, which then resets the password', async () => {
    const fx = identityFixtures(t);
    const { userId, email } = await fx.createActive();
    expect((await request(t.app).post(`${API}/auth/password/forgot`).send({ email })).status).toBe(200);

    // The outbox holds no plain OTP.
    const { otp } = await fx.latestSecret(userId, 'password_reset');
    const outbox = await t.infra.db.knex('events_outbox').where({ aggregate_id: userId }).select('payload');
    expect(JSON.stringify(outbox)).not.toContain(`"${otp}"`);

    await drain();
    await waitFor(() => sender.to(email).some((m) => m.subject === 'Reset your Nile password'));
    const message = sender.to(email).find((m) => m.subject === 'Reset your Nile password');
    expect(message?.text).toContain(otp);
    await waitFor(async () => (await logRows(userId)).some((r) => r.template === 'password_reset'));
    expect(await logRows(userId)).toContainEqual(
      expect.objectContaining({ template: 'password_reset', status: 'sent', error: null }),
    );

    const reset = await request(t.app)
      .post(`${API}/auth/password/reset`)
      .send({ email, otp: /\b(\d{6})\b/.exec(message?.text ?? '')?.[1], newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(204);

    // Neither the worker logs nor notification_log contain the OTP.
    expect(workerLogs.lines.join('\n')).not.toContain(otp);
    expect(JSON.stringify(await logRows(userId))).not.toContain(otp);
  });

  it('invite: the email carries a working invite link', async () => {
    const fx = identityFixtures(t);
    const { email } = await fx.createInvited();
    await drain();
    await waitFor(() => sender.to(email).length > 0);
    const link = /https:\/\/\S+token=([A-Za-z0-9_-]{43})/.exec(sender.to(email)[0]?.text ?? '');
    expect(link).not.toBeNull();
    const accept = await request(t.app)
      .post(`${API}/auth/invite/accept`)
      .send({ token: link?.[1], password: NEW_PASSWORD });
    expect(accept.status).toBe(200);
  });

  it('redelivery of the same event sends nothing twice', async () => {
    const fx = identityFixtures(t);
    const { userId, email } = await fx.createPending();
    await drain();
    // Wait for the commit, not just the send: notification_log is committed with processed_events,
    // and a redelivery that arrives before that commit may legitimately send again (architecture §3.2).
    await waitFor(async () => (await logRows(userId)).length === 1);
    const [row] = await t.infra.db
      .knex('events_outbox')
      .where({ aggregate_id: userId })
      .select<
        { id: string; event_type: string; event_version: number; payload: unknown; aggregate_type: string }[]
      >('id', 'event_type', 'event_version', 'payload', 'aggregate_type');

    // Republish the identical envelope, as RabbitMQ would after a lost ack.
    const envelope = {
      eventId: row?.id,
      eventType: row?.event_type,
      version: row?.event_version,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      aggregateType: row?.aggregate_type,
      aggregateId: userId,
      payload: row?.payload,
    };
    probe.channel.publish(
      worker.env.RABBITMQ_EXCHANGE,
      'notification.email_requested',
      Buffer.from(JSON.stringify(envelope)),
      { persistent: true },
    );
    await waitFor(() =>
      workerLogs.entries().some((e) => e.message === 'duplicate event skipped' && e.eventId === row?.id),
    );
    expect(sender.to(email)).toHaveLength(1);
    expect(await logRows(userId)).toHaveLength(1);
  });

  it('permanent provider failure: a `failed` row, EMAIL_SEND_FAILED, no retry', async () => {
    const fx = identityFixtures(t);
    const email = `bounce-${randomUUID()}@example.com`;
    sender.failures.set(
      email,
      new EmailSendError('email provider responded 400: invalid recipient', true, 400),
    );
    const { userId } = await fx.createPending(email);
    await drain();
    await waitFor(async () => (await logRows(userId)).length === 1);
    const [row] = await logRows(userId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('400');
    expect(workerLogs.entries().some((e) => e.event === 'EMAIL_SEND_FAILED' && e.userId === userId)).toBe(
      true,
    );
  });

  it('transient failure: retried with backoff, then sent once the provider recovers', async () => {
    const fx = identityFixtures(t);
    const email = `flaky-${randomUUID()}@example.com`;
    sender.failures.set(email, new EmailSendError('email provider responded 503', false, 503));
    const { userId } = await fx.createPending(email);
    await drain();
    await waitFor(() =>
      workerLogs.entries().some((e) => e.message === 'event handler failed, will retry' && e.attempt === 0),
    );
    sender.failures.delete(email);
    await waitFor(async () => (await logRows(userId)).some((r) => r.status === 'sent'));
    expect(sender.to(email)).toHaveLength(1);
  });

  it('undecryptable secrets: SECRET_DECRYPT_FAILED and the message goes to the DLQ', async () => {
    const userId = randomUUID();
    const dlq = deadLetterQueueName('notifications.email');
    const before = await probe.messageCount(dlq);
    probe.channel.publish(
      worker.env.RABBITMQ_EXCHANGE,
      'notification.email_requested',
      Buffer.from(
        JSON.stringify({
          eventId: randomUUID(),
          eventType: 'notification.email_requested',
          version: 1,
          occurredAt: new Date().toISOString(),
          correlationId: null,
          aggregateType: 'user',
          aggregateId: userId,
          payload: {
            template: 'email_verification',
            userId,
            toEmail: 'x@example.com',
            variables: { expiresInMinutes: 10 },
            encryptedSecrets: 'v1.test-s1.AAAA.BBBB.CCCC',
          },
        }),
      ),
      { persistent: true },
    );
    await waitFor(async () => (await probe.messageCount(dlq)) === before + 1);
    expect(workerLogs.entries().some((e) => e.event === 'SECRET_DECRYPT_FAILED' && e.userId === userId)).toBe(
      true,
    );
    expect(sender.to('x@example.com')).toHaveLength(0);
  });
});
