import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runWithContext } from '../../src/lib/context';
import { Outbox, OUTBOX_TABLE, OutboxDrainer, SellerApproved, SellerSuspended } from '../../src/lib/events';
import { closeInfrastructure, createInfrastructure } from '../../src/infrastructure';
import { AmqpProbe } from '../helpers/amqp-probe';
import { createMemoryLogger } from '../helpers/memory-logger';
import { startTestInfra, type TestInfra } from '../helpers/test-infra';

interface OutboxRow {
  id: string;
  event_type: string;
  correlation_id: string | null;
  attempts: number;
  dispatched_at: Date | null;
  next_attempt_at: Date;
  last_error: string | null;
}

describe('transactional outbox + drain (architecture §5, CLAUDE.md §6.4)', () => {
  let t: TestInfra;
  let probe: AmqpProbe;
  let tapQueue: string;
  let outbox: Outbox;

  const drainer = (infra = t.infra) =>
    new OutboxDrainer(infra.db.knex, infra.broker, infra.clock, infra.logger, {
      exchange: infra.env.RABBITMQ_EXCHANGE,
      batchSize: 50,
      maxBackoffMs: infra.env.OUTBOX_MAX_BACKOFF_MS,
    });
  const rows = () => t.infra.db.knex<OutboxRow>(OUTBOX_TABLE).select('*').orderBy('id');
  const addApproved = (sellerId = randomUUID()) =>
    t.infra.db.run((trx) =>
      outbox.add(trx, {
        contract: SellerApproved,
        aggregateId: sellerId,
        payload: { sellerId, userId: randomUUID(), previousStatus: 'pending_approval' },
      }),
    );

  beforeAll(async () => {
    t = await startTestInfra();
    outbox = new Outbox(t.infra.clock);
    await t.infra.broker.assertExchange(t.infra.env.RABBITMQ_EXCHANGE);
    probe = await AmqpProbe.open(t.infra.env.RABBITMQ_URL);
    tapQueue = await probe.tap(t.infra.env.RABBITMQ_EXCHANGE);
  });
  afterAll(async () => {
    await probe.close();
    await t.close();
  });
  beforeEach(async () => {
    await t.infra.db.knex(OUTBOX_TABLE).delete();
    await probe.drain(tapQueue);
  });

  it('writes events only when the surrounding transaction commits', async () => {
    await expect(
      t.infra.db.run(async (trx) => {
        await outbox.add(trx, {
          contract: SellerSuspended,
          aggregateId: randomUUID(),
          payload: { sellerId: randomUUID(), userId: randomUUID(), reason: 'x' },
        });
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    expect(await rows()).toHaveLength(0);

    const correlationId = randomUUID();
    await runWithContext({ correlationId }, () => addApproved());
    const [row] = await rows();
    expect(row).toMatchObject({ event_type: 'seller.approved', correlation_id: correlationId, attempts: 0 });
    expect(row?.dispatched_at).toBeNull();
  });

  it('publishes the envelope with confirms and marks rows dispatched', async () => {
    const sellerId = randomUUID();
    await addApproved(sellerId);
    expect(await drainer().drainOnce()).toBe(1);

    const [row] = await rows();
    expect(row?.dispatched_at).toBeInstanceOf(Date);
    const [message] = await probe.drain(tapQueue);
    expect(message?.messageId).toBe(row?.id);
    expect(message?.content).toMatchObject({
      eventId: row?.id,
      eventType: 'seller.approved',
      version: 1,
      aggregateType: 'seller',
      aggregateId: sellerId,
      payload: { sellerId, previousStatus: 'pending_approval' },
    });
    expect(await drainer().drainOnce()).toBe(0); // nothing left
  });

  it('two drainers in parallel publish every event exactly once (claim lease + SKIP LOCKED)', async () => {
    for (let i = 0; i < 40; i += 1) await addApproved();
    const second = await startTestInfraSharingDb();
    try {
      await Promise.all([drainer().drainOnce(), drainer(second.infra).drainOnce(), drainer().drainOnce()]);
      // Drain whatever a batch limit may have left.
      while ((await drainer().drainOnce()) > 0);
      const messages = await probe.drain(tapQueue);
      const ids = messages.map((m) => m.messageId);
      expect(ids).toHaveLength(40);
      expect(new Set(ids).size).toBe(40);
    } finally {
      await second.closeInfraOnly();
    }
  });

  it('a publish failure records attempts + backoff and leaves the row undispatched', async () => {
    await addApproved();
    const broken = await startTestInfraSharingDb();
    try {
      await broken.infra.broker.close(); // publishing now fails
      expect(await drainer(broken.infra).drainOnce()).toBe(0);
      const [row] = await rows();
      expect(row?.attempts).toBe(1);
      expect(row?.dispatched_at).toBeNull();
      expect(row?.last_error).toBeTruthy();
      expect(row?.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
      expect(broken.logs.entries().some((e) => e.event === 'OUTBOX_PUBLISH_FAILED')).toBe(true);
    } finally {
      await broken.closeInfraOnly();
    }
  });

  /** A second worker process: own connections, same database/vhost. */
  async function startTestInfraSharingDb() {
    const { logger, writer } = createMemoryLogger();
    const infra = await createInfrastructure(t.infra.env, logger);
    await infra.broker.assertExchange(infra.env.RABBITMQ_EXCHANGE);
    return { infra, logs: writer, closeInfraOnly: () => closeInfrastructure(infra) };
  }
});
