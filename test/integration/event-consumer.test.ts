import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getContext } from '../../src/lib/context';
import {
  EventConsumerHost,
  type EventEnvelope,
  type EventHandlerDefinition,
  PermanentEventError,
  PROCESSED_EVENTS_TABLE,
  SellerApproved,
  SellerSuspended,
} from '../../src/lib/events';
import { deadLetterQueueName } from '../../src/pkg/messaging';
import { AmqpProbe, waitFor } from '../helpers/amqp-probe';
import { startTestInfra, type TestInfra } from '../helpers/test-infra';

// testEnvInput: MQ_RETRY_DELAYS_MS = 100,200 → 3 tries, then the DLQ.
type Behaviour = 'ok' | 'fail-once' | 'always-fail' | 'permanent';

describe('event consumers: dedupe, retry/backoff, DLQ, correlation (architecture §3.2, §5)', () => {
  let t: TestInfra;
  let probe: AmqpProbe;
  const QUEUE = 'test.consumer';
  const calls: { eventId: string; correlationId: string | undefined; attempt: number }[] = [];
  const behaviours = new Map<string, Behaviour>();

  const handler: EventHandlerDefinition = {
    name: QUEUE,
    events: [SellerApproved, SellerSuspended],
    handle: (envelope: EventEnvelope) => {
      const seen = calls.filter((c) => c.eventId === envelope.eventId).length;
      calls.push({ eventId: envelope.eventId, correlationId: getContext()?.correlationId, attempt: seen });
      const behaviour = behaviours.get(envelope.eventId) ?? 'ok';
      if (behaviour === 'permanent') throw new PermanentEventError('cannot ever apply');
      if (behaviour === 'always-fail') throw new Error('downstream unavailable');
      if (behaviour === 'fail-once' && seen === 0) throw new Error('transient');
      return Promise.resolve();
    },
  };

  const envelope = (overrides: Partial<EventEnvelope> = {}): EventEnvelope => ({
    eventId: randomUUID(),
    eventType: 'seller.approved',
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    aggregateType: 'seller',
    aggregateId: randomUUID(),
    payload: { sellerId: randomUUID(), userId: randomUUID(), previousStatus: 'pending_approval' },
    ...overrides,
  });
  const publish = (content: unknown, routingKey = 'seller.approved') => {
    const body = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));
    probe.channel.publish(t.infra.env.RABBITMQ_EXCHANGE, routingKey, body, { persistent: true });
  };
  const callsFor = (eventId: string) => calls.filter((c) => c.eventId === eventId);
  const processedCount = async (eventId: string) =>
    Number(
      (
        await t.infra.db
          .knex(PROCESSED_EVENTS_TABLE)
          .where({ consumer: QUEUE, event_id: eventId })
          .count<{ count: string }[]>('* as count')
      )[0]?.count ?? 0,
    );

  beforeAll(async () => {
    t = await startTestInfra();
    probe = await AmqpProbe.open(t.infra.env.RABBITMQ_URL);
    await new EventConsumerHost(t.infra.broker, t.infra.db, t.infra.logger, t.infra.env).start(handler);
  });
  afterAll(async () => {
    await probe.close();
    await t.close();
  });

  it('processes an event once and restores its correlation id', async () => {
    const event = envelope();
    publish(event);
    await waitFor(() => callsFor(event.eventId).length === 1);
    expect(callsFor(event.eventId)[0]?.correlationId).toBe(event.correlationId);
    await waitFor(async () => (await processedCount(event.eventId)) === 1);
  });

  it('a redelivered duplicate (same eventId) is acknowledged without running the handler again', async () => {
    const event = envelope();
    publish(event);
    await waitFor(async () => (await processedCount(event.eventId)) === 1);
    publish(event);
    publish(event);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(callsFor(event.eventId)).toHaveLength(1);
  });

  it('a transient failure rolls back the dedupe row and is retried after the backoff', async () => {
    const event = envelope();
    behaviours.set(event.eventId, 'fail-once');
    publish(event);
    await waitFor(() => callsFor(event.eventId).length === 2);
    await waitFor(async () => (await processedCount(event.eventId)) === 1);
  });

  it('after the last retry the message goes to the DLQ and MQ_DEAD_LETTERED is logged', async () => {
    const event = envelope();
    behaviours.set(event.eventId, 'always-fail');
    publish(event);
    await waitFor(() => callsFor(event.eventId).length === 3); // first try + 2 retries
    await waitFor(async () => (await probe.messageCount(deadLetterQueueName(QUEUE))) >= 1);
    await waitFor(() =>
      t.logs.entries().some((e) => e.event === 'MQ_DEAD_LETTERED' && e.reason === 'retries_exhausted'),
    );
    expect(await processedCount(event.eventId)).toBe(0);
  });

  it('PermanentEventError and malformed messages go straight to the DLQ', async () => {
    const before = await probe.messageCount(deadLetterQueueName(QUEUE));
    const event = envelope();
    behaviours.set(event.eventId, 'permanent');
    publish(event);
    publish('{not json');
    publish(envelope({ version: 99 })); // unsupported version
    await waitFor(async () => (await probe.messageCount(deadLetterQueueName(QUEUE))) === before + 3);
    expect(callsFor(event.eventId)).toHaveLength(1);
  });
});
