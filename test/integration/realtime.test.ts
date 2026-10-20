import request from 'supertest';
import { ShipmentStatus } from '../../src/app/delivery/enums';
import { MediaStatus } from '../../src/app/media/enums';
import { PaymentStatus } from '../../src/app/payments/enums';
import { MediaStatusValue, PaymentStatusValue, ShipmentStatusValue } from '../../src/app/realtime/constants';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { type ISuspendedUsers } from '../../src/lib/auth';
import { TOKENS } from '../../src/lib/di';
import { EventConsumerHost, OutboxDrainer } from '../../src/lib/events';
import { waitFor } from '../helpers/amqp-probe';
import { signTestAccessToken } from '../helpers/jwt';
import { createMemoryLogger } from '../helpers/memory-logger';
import { orderingApi } from '../helpers/ordering-api';
import {
  connectErrorCode,
  connectSocket,
  startTestGateway,
  type TestGateway,
  type TestSocket,
} from '../helpers/realtime';
import { sellerFixtures } from '../helpers/sellers';
import { startTestApp, type TestApp } from '../helpers/test-app';

const ORIGIN = 'https://app.nile.test';

/*
 * Spec 15 end to end on real Postgres, Redis and RabbitMQ: two gateway tasks on one Redis adapter, the
 * api writing events, the worker's realtime.fanout consumer emitting through the Redis emitter.
 */
describe('realtime gateway and fan-out', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let first: TestGateway;
  let second: TestGateway;
  let worker: WorkerInfrastructure;
  let drainer: OutboxDrainer;
  const sockets: TestSocket[] = [];

  const open = async (url: string, token: string) => {
    const socket = await connectSocket(url, { token, origin: ORIGIN });
    sockets.push(socket);
    return socket;
  };
  /** Publishes what the api wrote, then waits for the fan-out to reach `until`. */
  const deliver = async (until: () => boolean) => {
    await drainer.drainOnce();
    await waitFor(until, 10_000);
  };

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { CORS_ALLOWED_ORIGINS: ORIGIN } });
    api = orderingApi(t);
    await api.init();
    first = await startTestGateway(t.resources.realtimeEnv);
    second = await startTestGateway(t.resources.realtimeEnv);

    const { logger } = createMemoryLogger();
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
  });
  afterAll(async () => {
    for (const { socket } of sockets) socket.close();
    await first.close();
    await second.close();
    await closeInfrastructure(worker);
    await t.close();
  });

  describe('handshake (UC-RT-1)', () => {
    it('refuses another origin or none, then a missing, malformed, expired or foreign token', async () => {
      const buyer = await api.customer();
      expect(await connectErrorCode(first.url, { token: buyer.token, origin: 'https://evil.test' })).toBe(
        'ORIGIN_NOT_ALLOWED',
      );
      expect(await connectErrorCode(first.url, { token: buyer.token, origin: null })).toBe(
        'ORIGIN_NOT_ALLOWED',
      );
      expect(await connectErrorCode(first.url, { origin: ORIGIN })).toBe('UNAUTHENTICATED');
      expect(await connectErrorCode(first.url, { token: 'not-a-jwt', origin: ORIGIN })).toBe(
        'UNAUTHENTICATED',
      );
      const expired = await signTestAccessToken({ sub: buyer.userId, expiresInSeconds: -10 });
      expect(await connectErrorCode(first.url, { token: expired, origin: ORIGIN })).toBe('UNAUTHENTICATED');
      const foreign = await signTestAccessToken({ sub: buyer.userId, issuer: 'someone-else' });
      expect(await connectErrorCode(first.url, { token: foreign, origin: ORIGIN })).toBe('UNAUTHENTICATED');
      expect(await connectErrorCode(first.url, { token: buyer.token, origin: ORIGIN })).toBe('connected');
    });

    it('a role without its profile is FORBIDDEN; a suspended user is UNAUTHENTICATED (deny entry, I-11)', async () => {
      const noProfile = await signTestAccessToken({ role: 'seller' });
      expect(await connectErrorCode(first.url, { token: noProfile, origin: ORIGIN })).toBe('FORBIDDEN');
      const buyer = await api.customer();
      await t.container.resolve<ISuspendedUsers>(TOKENS.SuspendedUsers).block(buyer.userId);
      expect(await connectErrorCode(first.url, { token: buyer.token, origin: ORIGIN })).toBe(
        'UNAUTHENTICATED',
      );
    });

    it('closes the socket at the token expiry with session.ended token_expired (RT-2)', async () => {
      const buyer = await api.customer();
      const token = await signTestAccessToken({ sub: buyer.userId, expiresInSeconds: 2 });
      const socket = await open(first.url, token);
      expect(await socket.disconnected).toBe('io server disconnect');
      expect(socket.of('session.ended').map((m) => m.data)).toEqual([{ reason: 'token_expired' }]);
    });

    it('the gateway serves its own probes: live, and ready over Postgres and Redis', async () => {
      const ready = await request(first.url).get('/health/ready');
      expect(ready.status).toBe(200);
      expect(Object.keys((ready.body as { data: { checks: object } }).data.checks).sort()).toEqual([
        'postgres',
        'redis',
      ]);
      expect((await request(first.url).get('/health/live')).status).toBe(200);
    });
  });

  describe('fan-out (UC-RT-2) across two gateway tasks', () => {
    it('order and seller-order messages reach only their rooms, whichever task holds the socket', async () => {
      const buyer = await api.customer();
      const other = await api.customer();
      const a = await api.listedVariant({ price: '100.00' });
      const buyerSocket = await open(first.url, buyer.token);
      const otherSocket = await open(second.url, other.token);
      const sellerSocket = await open(second.url, a.sellerToken);

      const { order } = await api.placeOrder(buyer, [{ variantId: a.variantId, quantity: 1 }], '150.00');
      await deliver(
        () => buyerSocket.of('order.updated').length > 0 && sellerSocket.of('seller_order.placed').length > 0,
      );
      const sellerOrderId = order.sellerOrders[0]?.id;
      expect(buyerSocket.of('order.updated')[0]).toMatchObject({
        type: 'order.updated',
        eventId: expect.any(String) as unknown,
        occurredAt: expect.any(String) as unknown,
        data: { orderId: order.id, orderNumber: order.orderNumber, status: 'placed' },
      });
      expect(sellerSocket.of('seller_order.placed').map((m) => m.data)).toEqual([
        { sellerOrderId, orderNumber: order.orderNumber },
      ]);
      // Re-read status: the seller accepts, both sides see `accepted`.
      expect((await api.as(a.sellerToken).post(`/seller/orders/${sellerOrderId}/accept`)).status).toBe(200);
      await deliver(() => buyerSocket.of('seller_order.updated').length > 0);
      await waitFor(() => sellerSocket.of('seller_order.updated').length > 0);
      for (const socket of [buyerSocket, sellerSocket]) {
        expect(socket.of('seller_order.updated').map((m) => m.data)).toEqual([
          { sellerOrderId, orderId: order.id, status: 'accepted' },
        ]);
      }
      // Nothing for anyone else, and nothing carries names, phones or amounts.
      expect(otherSocket.messages).toEqual([]);
      expect(JSON.stringify([...buyerSocket.messages, ...sellerSocket.messages])).not.toMatch(
        /Mona|\+20|150\.00/,
      );
    });

    it('user.suspended: the user gets session.ended account_suspended on every task, then cannot reconnect', async () => {
      const admin = await sellerFixtures(t).createActiveAdmin();
      const buyer = await api.customer();
      const onFirst = await open(first.url, buyer.token);
      const onSecond = await open(second.url, buyer.token);
      const suspend = await request(t.app)
        .post(`/api/v1/admin/users/${buyer.userId}/suspend`)
        .set('Authorization', `Bearer ${admin.session.accessToken}`)
        .send({ reason: 'fraud report' });
      expect(suspend.status).toBe(200);
      await drainer.drainOnce();
      expect(await onFirst.disconnected).toBe('io server disconnect');
      expect(await onSecond.disconnected).toBe('io server disconnect');
      // The reason travels on another Redis channel than the disconnect, so it may lose the race (RT-8).
      for (const socket of [onFirst, onSecond]) {
        for (const ended of socket.of('session.ended'))
          expect(ended.data).toEqual({ reason: 'account_suspended' });
      }
      expect(await connectErrorCode(second.url, { token: buyer.token, origin: ORIGIN })).toBe(
        'UNAUTHENTICATED',
      );
    });
  });

  describe('client signals (§3.3)', () => {
    it('more than REALTIME_SIGNAL_RATE_PER_SECOND signals in a second: the rest are acked RATE_LIMITED', async () => {
      const buyer = await api.customer();
      const { socket } = await open(first.url, buyer.token);
      const acks = await Promise.all(
        Array.from({ length: 7 }, () =>
          Promise.race([
            socket.emitWithAck('unknown.signal', {}),
            new Promise((resolve) => setTimeout(() => resolve('no ack'), 500)),
          ]),
        ),
      );
      // Unknown signals within the limit are ignored (no ack); the 6th and 7th are refused.
      expect(acks).toEqual([
        'no ack',
        'no ack',
        'no ack',
        'no ack',
        'no ack',
        { ok: false, code: 'RATE_LIMITED' },
        { ok: false, code: 'RATE_LIMITED' },
      ]);
      expect(socket.connected).toBe(true);
    });
  });

  describe('shutdown (UC-RT-4)', () => {
    it('every socket of the task gets session.ended server_shutting_down and is closed', async () => {
      const extra = await startTestGateway(t.resources.realtimeEnv);
      const buyer = await api.customer();
      const socket = await connectSocket(extra.url, { token: buyer.token, origin: ORIGIN });
      await extra.close();
      expect(await socket.disconnected).toBe('io server disconnect');
      expect(socket.of('session.ended').map((m) => m.data)).toEqual([{ reason: 'server_shutting_down' }]);
    });
  });

  it('the status values realtime mirrors are values of the owning enums (RT-9)', () => {
    const subsetOf = (mirror: object, owner: object) =>
      expect(Object.values(owner)).toEqual(expect.arrayContaining(Object.values(mirror)));
    subsetOf(PaymentStatusValue, PaymentStatus);
    subsetOf(ShipmentStatusValue, ShipmentStatus);
    subsetOf(MediaStatusValue, MediaStatus);
  });
});
