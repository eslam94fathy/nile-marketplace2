import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type NotificationPreferenceDto,
  type UserNotificationDto,
} from '../../src/app/notifications/dto/notification-response.dto';
import { type NotificationRetentionJob } from '../../src/app/notifications/service/notification-center.service';
import { type UserEventsService } from '../../src/app/notifications/service/user-events.service';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { TOKENS } from '../../src/lib/di';
import { EventConsumerHost, type EventEnvelope, OutboxDrainer } from '../../src/lib/events';
import { waitFor } from '../helpers/amqp-probe';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { createMemoryLogger } from '../helpers/memory-logger';
import { orderingApi } from '../helpers/ordering-api';
import { connectSocket, startTestGateway, type TestGateway } from '../helpers/realtime';
import { startTestApp, type TestApp } from '../helpers/test-app';

const ORIGIN = 'https://app.nile.test';
const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

/*
 * Spec 13 §8 (R2-P2 step 5) on real Postgres, Redis and RabbitMQ: the notification-centre endpoints,
 * the notifications.user-events consumer (rows, push requests, the socket message) and retention.
 */
describe('notification centre', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let worker: WorkerInfrastructure;
  let workerContainer: ReturnType<typeof createWorkerContainer>;
  let drainer: OutboxDrainer;
  let gateway: TestGateway;

  const knex = () => t.infra.db.knex;
  const as = (token: string | undefined) => {
    const auth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
    return {
      get: (path: string) => auth(request(t.app).get(`${API}${path}`)),
      post: (path: string) => auth(request(t.app).post(`${API}${path}`)),
      put: (path: string, body: object) => auth(request(t.app).put(`${API}${path}`)).send(body),
    };
  };
  /** A row straight in the table, `ageMs` old. */
  const insertNotification = async (userId: string, overrides: Record<string, unknown> = {}, ageMs = 0) => {
    const [row] = await knex()('user_notifications')
      .insert({
        user_id: userId,
        category: 'orders',
        type: 'order_placed',
        title: 'Order placed',
        body: 'Order #NM-000000001 is confirmed.',
        link: '/orders/x',
        source_event_id: randomUUID(),
        read_at: null,
        push_sent_at: null,
        created_at: new Date(Date.now() - ageMs),
        ...overrides,
      })
      .returning<{ id: string }[]>('id');
    if (!row) throw new Error('insert returned no row');
    return row.id;
  };
  const rowsOf = (userId: string) =>
    knex()('user_notifications')
      .where({ user_id: userId })
      .orderBy('created_at')
      .select<{ id: string; type: string; category: string; body: string; link: string | null }[]>(
        'id',
        'type',
        'category',
        'body',
        'link',
      );
  const pushRequestsFor = async (userId: string) =>
    (
      await knex()('events_outbox')
        .where({ event_type: 'notification.push_requested' })
        .select<{ payload: { userId: string; notificationId: string } }[]>('payload')
    )
      .map((row) => row.payload)
      .filter((payload) => payload.userId === userId);

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { CORS_ALLOWED_ORIGINS: ORIGIN } });
    api = orderingApi(t);
    await api.init();
    const { logger } = createMemoryLogger();
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    workerContainer = createWorkerContainer(worker);
    await worker.broker.assertExchange(worker.env.RABBITMQ_EXCHANGE);
    const consumers = new EventConsumerHost(worker.broker, worker.db, logger, worker.env);
    for (const handler of createEventHandlers(workerContainer)) await consumers.start(handler);
    drainer = new OutboxDrainer(worker.db.knex, worker.broker, worker.clock, logger, {
      exchange: worker.env.RABBITMQ_EXCHANGE,
      batchSize: worker.env.OUTBOX_BATCH_SIZE,
      maxBackoffMs: worker.env.OUTBOX_MAX_BACKOFF_MS,
    });
    gateway = await startTestGateway(t.resources.realtimeEnv);
  });
  afterAll(async () => {
    await gateway.close();
    await closeInfrastructure(worker);
    await t.close();
  });

  describe('GET /me/notifications, unread-count, read, read-all', () => {
    it('lists only my notifications, newest first, paging without gaps; filters read and category', async () => {
      const me = await api.customer();
      const other = await api.customer();
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(await insertNotification(me.userId, {}, (5 - i) * 1000));
      await insertNotification(me.userId, { category: 'shipments', type: 'delivered', read_at: new Date() });
      await insertNotification(other.userId);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await as(me.token).get(`/me/notifications?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        const body = successBody<UserNotificationDto[]>(res);
        seen.push(...body.data.map((n) => n.id));
        cursor = (body.meta as { nextCursor: string | null }).nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(6);
      expect(seen.slice(1)).toEqual([...ids].reverse());

      const unread = successBody<UserNotificationDto[]>(
        await as(me.token).get('/me/notifications?read[eq]=false'),
      ).data;
      expect(unread.map((n) => n.id).sort()).toEqual([...ids].sort());
      expect(unread.every((n) => !n.read)).toBe(true);
      const shipments = successBody<UserNotificationDto[]>(
        await as(me.token).get('/me/notifications?category[in]=shipments,support'),
      ).data;
      expect(shipments.map((n) => [n.type, n.read])).toEqual([['delivered', true]]);
      expect(shipments[0]).toEqual({
        id: expect.any(String) as unknown,
        category: 'shipments',
        type: 'delivered',
        title: 'Order placed',
        body: 'Order #NM-000000001 is confirmed.',
        link: '/orders/x',
        read: true,
        createdAt: expect.any(String) as unknown,
      });
    });

    it('400 for an unknown filter, a wrong operator or value', async () => {
      const me = await api.customer();
      for (const query of [
        'status[eq]=x',
        'read[in]=true',
        'read[eq]=yes',
        'category[eq]=news',
        'sort=title',
      ]) {
        const res = await as(me.token).get(`/me/notifications?${query}`);
        expect([res.status, errorBody(res).error.code], query).toEqual([400, 'INVALID_QUERY']);
      }
    });

    it('unread-count counts up to 100', async () => {
      const me = await api.customer();
      const count = async () =>
        successBody<{ count: number }>(await as(me.token).get('/me/notifications/unread-count')).data.count;
      expect(await count()).toBe(0);
      await knex()('user_notifications').insert(
        Array.from({ length: 101 }, () => ({
          user_id: me.userId,
          category: 'orders',
          type: 'order_placed',
          title: 't',
          body: 'b',
          link: null,
          source_event_id: randomUUID(),
          read_at: null,
          push_sent_at: null,
        })),
      );
      expect(await count()).toBe(100);
    });

    it("read marks one; again is a no-op; another user's or an unknown id is 404; read-all marks the rest", async () => {
      const me = await api.customer();
      const other = await api.customer();
      const first = await insertNotification(me.userId);
      await insertNotification(me.userId);
      const theirs = await insertNotification(other.userId);

      expect((await as(me.token).post(`/me/notifications/${first}/read`)).status).toBe(204);
      expect((await as(me.token).post(`/me/notifications/${first}/read`)).status).toBe(204);
      for (const id of [theirs, UNKNOWN_ID]) {
        const res = await as(me.token).post(`/me/notifications/${id}/read`);
        expect([res.status, errorBody(res).error.code]).toEqual([404, 'NOTIFICATION_NOT_FOUND']);
      }
      expect((await as(me.token).post('/me/notifications/not-a-uuid/read')).status).toBe(400);
      expect(
        successBody<{ count: number }>(await as(me.token).get('/me/notifications/unread-count')).data.count,
      ).toBe(1);

      expect((await as(me.token).post('/me/notifications/read-all')).status).toBe(204);
      expect(
        successBody<{ count: number }>(await as(me.token).get('/me/notifications/unread-count')).data.count,
      ).toBe(0);
      // The other user's notification is untouched.
      expect(
        (await knex()('user_notifications').where({ id: theirs }).first<{ read_at: Date | null }>('read_at'))
          ?.read_at,
      ).toBeNull();
    });

    it('every route needs a token (401); every role may use it', async () => {
      for (const res of [
        await as(undefined).get('/me/notifications'),
        await as(undefined).get('/me/notifications/unread-count'),
        await as(undefined).post(`/me/notifications/${UNKNOWN_ID}/read`),
        await as(undefined).post('/me/notifications/read-all'),
        await as(undefined).get('/me/notification-preferences'),
        await as(undefined).put('/me/notification-preferences', { preferences: [] }),
      ]) {
        expect(res.status).toBe(401);
      }
      const { sellerToken } = await api.listedVariant();
      expect((await as(sellerToken).get('/me/notifications')).status).toBe(200);
    });
  });

  describe('notification preferences', () => {
    it('defaults (promotions off), a partial change keeps the rest, and validation', async () => {
      const me = await api.customer();
      const prefs = async () =>
        successBody<NotificationPreferenceDto[]>(await as(me.token).get('/me/notification-preferences')).data;
      expect(await prefs()).toEqual([
        { category: 'orders', pushEnabled: true },
        { category: 'shipments', pushEnabled: true },
        { category: 'support', pushEnabled: true },
        { category: 'promotions', pushEnabled: false },
      ]);
      const changed = await as(me.token).put('/me/notification-preferences', {
        preferences: [
          { category: 'orders', pushEnabled: false },
          { category: 'promotions', pushEnabled: true },
        ],
      });
      expect(changed.status).toBe(200);
      expect(successBody<NotificationPreferenceDto[]>(changed).data).toEqual(await prefs());
      expect((await prefs()).map((p) => p.pushEnabled)).toEqual([false, true, true, true]);
      await as(me.token).put('/me/notification-preferences', {
        preferences: [{ category: 'orders', pushEnabled: true }],
      });
      expect((await prefs()).map((p) => p.pushEnabled)).toEqual([true, true, true, true]);

      for (const body of [
        { preferences: [] },
        { preferences: [{ category: 'news', pushEnabled: true }] },
        { preferences: [{ category: 'orders', pushEnabled: 'yes' }] },
        {
          preferences: [
            { category: 'orders', pushEnabled: true },
            { category: 'orders', pushEnabled: false },
          ],
        },
        { preferences: [{ category: 'orders', pushEnabled: true, extra: 1 }] },
        {},
      ]) {
        const res = await as(me.token).put('/me/notification-preferences', body);
        expect([res.status, errorBody(res).error.code], JSON.stringify(body)).toEqual([
          400,
          'VALIDATION_FAILED',
        ]);
      }
    });
  });

  describe('consumer notifications.user-events (UC-NO-2)', () => {
    it('order placed: rows for the customer and the seller, a push request unless muted, the socket message', async () => {
      const buyer = await api.customer();
      const a = await api.listedVariant({ price: '100.00' });
      // The seller mutes `orders` for push: the row still exists, no push request.
      await as(a.sellerToken).put('/me/notification-preferences', {
        preferences: [{ category: 'orders', pushEnabled: false }],
      });
      const socket = await connectSocket(gateway.url, { token: buyer.token, origin: ORIGIN });
      const { order } = await api.placeOrder(buyer, [{ variantId: a.variantId, quantity: 1 }], '150.00');
      const sellerOrderId = order.sellerOrders[0]?.id ?? '';
      await drainer.drainOnce();
      await waitFor(
        async () => (await rowsOf(buyer.userId)).length === 1 && (await rowsOf(a.sellerUserId)).length === 1,
      );

      const [customerRow] = await rowsOf(buyer.userId);
      expect(customerRow).toMatchObject({
        type: 'order_placed',
        category: 'orders',
        body: `Order #${order.orderNumber} is confirmed.`,
        link: `/orders/${order.id}`,
      });
      expect(await rowsOf(a.sellerUserId)).toMatchObject([
        { type: 'seller_order_received', link: `/seller/orders/${sellerOrderId}` },
      ]);
      expect(await pushRequestsFor(buyer.userId)).toEqual([
        { userId: buyer.userId, notificationId: customerRow?.id },
      ]);
      expect(await pushRequestsFor(a.sellerUserId)).toEqual([]);

      await waitFor(() => socket.of('notification.created').length > 0);
      expect(socket.of('notification.created')[0]?.data).toEqual({
        notificationId: customerRow?.id,
        category: 'orders',
        title: 'Order placed',
        body: `Order #${order.orderNumber} is confirmed.`,
        link: `/orders/${order.id}`,
      });
      socket.socket.close();

      // The seller accepts: "Order #n was accepted." (one seller order, NO-13).
      expect((await api.as(a.sellerToken).post(`/seller/orders/${sellerOrderId}/accept`)).status).toBe(200);
      await drainer.drainOnce();
      await waitFor(async () => (await rowsOf(buyer.userId)).length === 2);
      expect((await rowsOf(buyer.userId))[1]).toMatchObject({
        type: 'seller_order_accepted',
        body: `Order #${order.orderNumber} was accepted.`,
      });
    });

    it('a redelivered event adds no row and no push request (one row per event and recipient)', async () => {
      const buyer = await api.customer();
      const a = await api.listedVariant({ price: '100.00' });
      const { order } = await api.placeOrder(buyer, [{ variantId: a.variantId, quantity: 1 }], '150.00');
      const service = workerContainer.resolve<UserEventsService>(TOKENS.UserEventsService);
      const event: EventEnvelope = {
        eventId: randomUUID(),
        eventType: 'order.placed',
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: null,
        aggregateType: 'order',
        aggregateId: order.id,
        payload: { orderId: order.id },
      };
      for (let i = 0; i < 2; i += 1) {
        const prepared = await service.prepare(event);
        await worker.db.run((trx) => service.record(prepared, trx));
      }
      // Customer + seller: two rows and two push requests, however often the event arrives.
      const fromThisEvent = knex()('user_notifications')
        .select('id')
        .where({ source_event_id: event.eventId });
      expect(
        await knex()('user_notifications')
          .where({ source_event_id: event.eventId })
          .count<{ count: string }[]>('* as count'),
      ).toEqual([{ count: '2' }]);
      expect(
        await knex()('events_outbox')
          .where({ event_type: 'notification.push_requested' })
          .whereIn('aggregate_id', fromThisEvent)
          .count<{ count: string }[]>('* as count'),
      ).toEqual([{ count: '2' }]);
    });
  });

  describe('retention job (UC-NO-5)', () => {
    it('deletes rows older than NOTIFICATION_RETENTION_DAYS in batches and keeps the rest', async () => {
      const me = await api.customer();
      const DAY = 86_400_000;
      const old = await Promise.all([1, 2, 3].map(() => insertNotification(me.userId, {}, 91 * DAY)));
      const fresh = await insertNotification(me.userId, {}, 89 * DAY);
      const job = workerContainer.resolve<NotificationRetentionJob>(TOKENS.NotificationRetentionJob);
      expect(await job.run(90, 2)).toBeGreaterThanOrEqual(3);
      const left = (await rowsOf(me.userId)).map((row) => row.id);
      expect(left).toContain(fresh);
      for (const id of old) expect(left).not.toContain(id);
    });
  });
});
