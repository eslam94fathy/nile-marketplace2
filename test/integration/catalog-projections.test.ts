import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG_LISTING_PROJECTIONS_QUEUE } from '../../src/app/catalog/constants';
import { type ProductListItemDto } from '../../src/app/catalog/dto/product-public.dto';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { EventConsumerHost, OutboxDrainer } from '../../src/lib/events';
import { deadLetterQueueName } from '../../src/pkg/messaging';
import { AmqpProbe, waitFor } from '../helpers/amqp-probe';
import { catalogApi } from '../helpers/catalog-api';
import { successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { createMemoryLogger, type MemoryLogWriter } from '../helpers/memory-logger';
import { sellerFixtures } from '../helpers/sellers';
import { startTestApp, type TestApp } from '../helpers/test-app';

/*
 * Spec 06 UC-CA-7 end to end on real Postgres + RabbitMQ: api write → outbox → drain →
 * catalog.listing-projections consumer → products.seller_active / in_stock → public reads.
 */
describe('catalog: listing projections consumer', () => {
  let t: TestApp;
  let api: ReturnType<typeof catalogApi>;
  let adminToken: string;
  let worker: WorkerInfrastructure;
  let workerLogs: MemoryLogWriter;
  let drainer: OutboxDrainer;
  let probe: AmqpProbe;
  let category: string;

  const knex = () => t.infra.db.knex;
  const projection = (productId: string) =>
    knex()('products')
      .where({ id: productId })
      .first<{ seller_active: boolean; in_stock: boolean }>('seller_active', 'in_stock');
  const publicStatus = async (productId: string) =>
    (await request(t.app).get(`${API}/products/${productId}`)).status;
  const publicIds = async (query: string) =>
    successBody<ProductListItemDto[]>(await request(t.app).get(`${API}/products?${query}`)).data.map(
      (p) => p.id,
    );
  const adjust = (token: string, variantId: string, delta: number) =>
    request(t.app)
      .post(`${API}/seller/variants/${variantId}/stock-adjustments`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ delta });
  const publish = (routingKey: string, envelope: object) =>
    probe.channel.publish(worker.env.RABBITMQ_EXCHANGE, routingKey, Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
    });

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '10000' } });
    adminToken = (await sellerFixtures(t).createActiveAdmin()).session.accessToken;
    api = catalogApi(t, adminToken);
    category = (await api.category()).id;

    const { logger, writer } = createMemoryLogger();
    workerLogs = writer;
    // Same database, vhost and keys as the api: a worker next to it.
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    const container = createWorkerContainer(worker);
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

  it('seller.suspended hides every product of the seller; seller.approved (reinstate) shows them again', async () => {
    const seller = await api.approvedSeller();
    const first = await api.product(seller.token, category, 'Lamp one', [{ price: '10.00', stock: 1 }]);
    const second = await api.product(seller.token, category, 'Lamp two', [{ price: '12.00', stock: 1 }]);
    await drainer.drainOnce(); // the approval event from setup

    expect(
      (await api.send('post', adminToken, `/admin/sellers/${seller.sellerId}/suspend`, { reason: 'Audit' }))
        .status,
    ).toBe(200);
    await drainer.drainOnce();
    await waitFor(async () => (await projection(first.id))?.seller_active === false);
    expect((await projection(second.id))?.seller_active).toBe(false);
    expect(await publicStatus(first.id)).toBe(404);
    expect(await publicIds(`sellerId[eq]=${seller.sellerId}`)).toEqual([]);

    expect((await api.send('post', adminToken, `/admin/sellers/${seller.sellerId}/reinstate`)).status).toBe(
      200,
    );
    await drainer.drainOnce();
    await waitFor(async () => (await projection(first.id))?.seller_active === true);
    expect(await publicStatus(first.id)).toBe(200);
    expect((await publicIds(`sellerId[eq]=${seller.sellerId}`)).sort()).toEqual([first.id, second.id].sort());
  });

  it('inventory.stock_status_changed keeps in_stock in line with sellable stock', async () => {
    const seller = await api.approvedSeller();
    const item = await api.product(seller.token, category, 'Vase', [{ price: '30.00', stock: 1 }]);
    const variantId = item.variants[0]?.id ?? '';
    expect((await projection(item.id))?.in_stock).toBe(true);

    expect((await adjust(seller.token, variantId, -1)).status).toBe(200);
    await drainer.drainOnce();
    await waitFor(async () => (await projection(item.id))?.in_stock === false);
    expect(await publicIds(`sellerId[eq]=${seller.sellerId}&inStock[eq]=false`)).toEqual([item.id]);

    expect((await adjust(seller.token, variantId, 4)).status).toBe(200);
    await drainer.drainOnce();
    await waitFor(async () => (await projection(item.id))?.in_stock === true);
  });

  it('a replayed or stale event re-reads the current state, so it changes nothing', async () => {
    const seller = await api.approvedSeller();
    const item = await api.product(seller.token, category, 'Bowl', [{ price: '8.00', stock: 2 }]);
    await drainer.drainOnce();
    // A stale "suspended" event (new eventId, so not deduplicated) while the seller is approved.
    publish('seller.suspended', {
      eventId: randomUUID(),
      eventType: 'seller.suspended',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      aggregateType: 'seller',
      aggregateId: seller.sellerId,
      payload: { sellerId: seller.sellerId, userId: seller.userId, reason: 'old' },
    });
    await waitFor(() =>
      workerLogs
        .entries()
        .some((e) => e.message === 'seller listing projection applied' && e.sellerId === seller.sellerId),
    );
    expect((await projection(item.id))?.seller_active).toBe(true);
    // A stock event for a variant that still has stock leaves in_stock true.
    const stockEventId = randomUUID();
    publish('inventory.stock_status_changed', {
      eventId: stockEventId,
      eventType: 'inventory.stock_status_changed',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      aggregateType: 'inventory_item',
      aggregateId: randomUUID(),
      payload: { variantId: item.variants[0]?.id, inStock: false },
    });
    // Committed together with the handler's effects (architecture §3.2).
    await waitFor(
      async () =>
        (
          await knex()('processed_events').where({
            consumer: CATALOG_LISTING_PROJECTIONS_QUEUE,
            event_id: stockEventId,
          })
        ).length === 1,
    );
    expect((await projection(item.id))?.in_stock).toBe(true);
  });

  it('a malformed payload goes to the DLQ', async () => {
    const dlq = deadLetterQueueName(CATALOG_LISTING_PROJECTIONS_QUEUE);
    const before = await probe.messageCount(dlq);
    publish('seller.approved', {
      eventId: randomUUID(),
      eventType: 'seller.approved',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      aggregateType: 'seller',
      aggregateId: randomUUID(),
      payload: { sellerId: 'not-a-uuid' },
    });
    await waitFor(async () => (await probe.messageCount(dlq)) === before + 1);
  });
});
