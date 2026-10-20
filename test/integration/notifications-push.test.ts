import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { TOKENS } from '../../src/lib/di';
import { EventConsumerHost, OutboxDrainer } from '../../src/lib/events';
import { type IPushSender, type PushMessage, type PushOutcome, type PushTarget } from '../../src/pkg/push';
import { waitFor } from '../helpers/amqp-probe';
import { errorBody, successBody } from '../helpers/http';
import { API, identityFixtures, NEW_PASSWORD } from '../helpers/identity';
import { createMemoryLogger } from '../helpers/memory-logger';
import { orderingApi } from '../helpers/ordering-api';
import { sellerFixtures } from '../helpers/sellers';
import { TEST_VAPID_KEYS } from '../helpers/test-env';
import { startTestApp, type TestApp } from '../helpers/test-app';

/** Answers per endpoint from a script (default `delivered`), and records every send. */
class ScriptedPushSender implements IPushSender {
  readonly sent: { endpoint: string; message: PushMessage }[] = [];
  private readonly scripts = new Map<string, PushOutcome[]>();

  script(endpoint: string, outcomes: PushOutcome[]): void {
    this.scripts.set(endpoint, [...outcomes]);
  }

  send(target: PushTarget, message: PushMessage) {
    this.sent.push({ endpoint: target.endpoint, message });
    const outcome = this.scripts.get(target.endpoint)?.shift() ?? 'delivered';
    return Promise.resolve({
      outcome,
      statusCode: { delivered: 201, gone: 410, rejected: 400, transient: 503 }[outcome],
    });
  }

  to(endpoint: string) {
    return this.sent.filter((s) => s.endpoint === endpoint);
  }
}

/** A subscription body as the browser's `PushSubscription.toJSON()` gives it. */
function browserSubscription(host = 'fcm.googleapis.com') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://${host}/fcm/send/${randomUUID()}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

/*
 * Spec 13 UC-NO-3, UC-NO-4 (R2-P2 step 6) on real Postgres, Redis and RabbitMQ: the push endpoints,
 * the notifications.push consumer with a scripted push sender, and the session-end clean-up.
 */
describe('web push', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let worker: WorkerInfrastructure;
  let drainer: OutboxDrainer;
  const sender = new ScriptedPushSender();

  const knex = () => t.infra.db.knex;
  const as = (token: string | undefined) => {
    const auth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
    return {
      get: (path: string) => auth(request(t.app).get(`${API}${path}`)),
      post: (path: string, body?: object) => auth(request(t.app).post(`${API}${path}`)).send(body),
      put: (path: string, body: object) => auth(request(t.app).put(`${API}${path}`)).send(body),
    };
  };
  const endpointsOf = async (userId: string) =>
    (
      await knex()('push_subscriptions')
        .where({ user_id: userId })
        .orderBy('created_at')
        .select<{ endpoint: string }[]>('endpoint')
    ).map((row) => row.endpoint);
  const subscriptionRow = (endpoint: string) =>
    knex()('push_subscriptions')
      .where({ endpoint })
      .first<{ user_id: string; last_success_at: Date | null } | undefined>('user_id', 'last_success_at');
  /** Drains the outbox until `until` holds: one pass per hop (user-events → push). */
  const settle = async (until: () => Promise<boolean> | boolean) => {
    await waitFor(async () => {
      await drainer.drainOnce();
      return until();
    }, 15_000);
  };
  const register = async (token: string, host?: string) => {
    const body = browserSubscription(host);
    const res = await as(token).post('/me/push-subscriptions', body);
    expect(res.status).toBe(201);
    return body.endpoint;
  };

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
    const { logger } = createMemoryLogger();
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    const container = createWorkerContainer(worker);
    // Before the handlers resolve their services: no real push service in tests.
    container.register(TOKENS.PushSender, { useValue: sender });
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
    await closeInfrastructure(worker);
    await t.close();
  });

  describe('endpoints (UC-NO-4)', () => {
    it('GET /push/config gives the VAPID public key to an authenticated user', async () => {
      const me = await api.customer();
      const res = await as(me.token).get('/push/config');
      expect(successBody<{ vapidPublicKey: string }>(res).data).toEqual({
        vapidPublicKey: TEST_VAPID_KEYS.publicKey,
      });
      expect((await as(undefined).get('/push/config')).status).toBe(401);
    });

    it('register accepts toJSON() as is; an endpoint moves to the user who registers it last', async () => {
      const first = await api.customer();
      const second = await api.customer();
      const body = { ...browserSubscription(), userAgent: 'Chrome on Windows' };
      expect((await as(first.token).post('/me/push-subscriptions', body)).status).toBe(201);
      expect((await as(first.token).post('/me/push-subscriptions', body)).status).toBe(201);
      expect(await endpointsOf(first.userId)).toEqual([body.endpoint]);
      expect((await as(second.token).post('/me/push-subscriptions', body)).status).toBe(201);
      expect(await endpointsOf(first.userId)).toEqual([]);
      expect(await endpointsOf(second.userId)).toEqual([body.endpoint]);
    });

    it('the 11th browser deletes the oldest (at most 10, also under parallel registrations)', async () => {
      const me = await api.customer();
      const endpoints: string[] = [];
      for (let i = 0; i < 10; i += 1) endpoints.push(await register(me.token));
      await Promise.all([register(me.token), register(me.token)]);
      const kept = await endpointsOf(me.userId);
      expect(kept).toHaveLength(10);
      expect(kept).not.toContain(endpoints[0]);
      expect(kept).not.toContain(endpoints[1]);
    });

    it('an endpoint outside the push services is 422 PUSH_ENDPOINT_NOT_ALLOWED (SSRF guard)', async () => {
      const me = await api.customer();
      for (const endpoint of [
        'https://evil.example.com/push',
        'https://fcm.googleapis.com:8443/fcm/send/x',
        'https://169.254.169.254.nip.io/latest',
      ]) {
        const res = await as(me.token).post('/me/push-subscriptions', { ...browserSubscription(), endpoint });
        expect([res.status, errorBody(res).error.code], endpoint).toEqual([422, 'PUSH_ENDPOINT_NOT_ALLOWED']);
      }
      expect(await endpointsOf(me.userId)).toEqual([]);
    });

    it('400 VALIDATION_FAILED: http, a bad key, an unknown field, a missing key', async () => {
      const me = await api.customer();
      const good = browserSubscription();
      for (const body of [
        { ...good, endpoint: 'http://fcm.googleapis.com/fcm/send/x' },
        { ...good, keys: { ...good.keys, p256dh: 'not base64url!' } },
        { ...good, keys: { p256dh: good.keys.p256dh } },
        { ...good, extra: true },
        { keys: good.keys },
      ]) {
        const res = await as(me.token).post('/me/push-subscriptions', body);
        expect([res.status, errorBody(res).error.code], JSON.stringify(body)).toEqual([
          400,
          'VALIDATION_FAILED',
        ]);
      }
      expect((await as(undefined).post('/me/push-subscriptions', good)).status).toBe(401);
    });

    it("unregister removes the caller's own endpoint; another user's or an unknown one is a quiet 204", async () => {
      const me = await api.customer();
      const other = await api.customer();
      const mine = await register(me.token);
      const theirs = await register(other.token);
      expect(
        (await as(me.token).post('/me/push-subscriptions/unregister', { endpoint: theirs })).status,
      ).toBe(204);
      expect(
        (await as(me.token).post('/me/push-subscriptions/unregister', { endpoint: 'https://x.test/1' }))
          .status,
      ).toBe(204);
      expect(await endpointsOf(other.userId)).toEqual([theirs]);
      expect((await as(me.token).post('/me/push-subscriptions/unregister', { endpoint: mine })).status).toBe(
        204,
      );
      expect(await endpointsOf(me.userId)).toEqual([]);
    });
  });

  describe('consumer notifications.push (UC-NO-3)', () => {
    /** A COD order of a fresh customer with `browsers` registered: the order_placed row is pushed. */
    async function orderWithBrowsers(browsers: number) {
      const buyer = await api.customer();
      const endpoints: string[] = [];
      for (let i = 0; i < browsers; i += 1) endpoints.push(await register(buyer.token));
      const a = await api.listedVariant({ price: '100.00' });
      const { order } = await api.placeOrder(buyer, [{ variantId: a.variantId, quantity: 1 }], '150.00');
      return { buyer, endpoints, order };
    }
    const notificationOf = (userId: string) =>
      knex()('user_notifications')
        .where({ user_id: userId, type: 'order_placed' })
        .first<{ id: string; push_sent_at: Date | null } | undefined>('id', 'push_sent_at');

    it('sends the row to every browser (payload, TTL 24 h, normal urgency); records the success', async () => {
      const { buyer, endpoints, order } = await orderWithBrowsers(2);
      await settle(async () => (await notificationOf(buyer.userId))?.push_sent_at != null);
      const row = await notificationOf(buyer.userId);
      for (const endpoint of endpoints) {
        const [sent] = sender.to(endpoint);
        expect(sent?.message).toMatchObject({ ttlSeconds: 86_400, urgency: 'normal' });
        expect(JSON.parse(sent?.message.payload ?? '{}')).toEqual({
          notificationId: row?.id,
          title: 'Order placed',
          body: `Order #${order.orderNumber} is confirmed.`,
          link: `/orders/${order.id}`,
          category: 'orders',
        });
        expect((await subscriptionRow(endpoint))?.last_success_at).not.toBeNull();
      }
    });

    it('410 deletes that subscription; the other device still gets it', async () => {
      const buyer = await api.customer();
      const goneEndpoint = await register(buyer.token);
      const liveEndpoint = await register(buyer.token);
      sender.script(goneEndpoint, ['gone']);
      const a = await api.listedVariant({ price: '100.00' });
      await api.placeOrder(buyer, [{ variantId: a.variantId, quantity: 1 }], '150.00');
      await settle(async () => (await subscriptionRow(goneEndpoint)) === undefined);
      expect(sender.to(liveEndpoint)).toHaveLength(1);
      expect(await endpointsOf(buyer.userId)).toEqual([liveEndpoint]);
    });

    it('every device failing transiently is retried; a partial success is not resent', async () => {
      const buyer = await api.customer();
      const flaky = await register(buyer.token);
      sender.script(flaky, ['transient', 'transient']);
      const a = await api.listedVariant({ price: '100.00' });
      await api.placeOrder(buyer, [{ variantId: a.variantId, quantity: 1 }], '150.00');
      // MQ_RETRY_DELAYS_MS = 100,200 in tests: the third try succeeds.
      await settle(async () => (await notificationOf(buyer.userId))?.push_sent_at != null);
      expect(sender.to(flaky).length).toBe(3);

      const mixed = await api.customer();
      const ok = await register(mixed.token);
      const down = await register(mixed.token);
      sender.script(down, ['transient']);
      const b = await api.listedVariant({ price: '100.00' });
      await api.placeOrder(mixed, [{ variantId: b.variantId, quantity: 1 }], '150.00');
      await settle(async () => (await notificationOf(mixed.userId))?.push_sent_at != null);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect([sender.to(ok).length, sender.to(down).length]).toEqual([1, 1]);
    });

    it('muted after the request, or no browser at all: nothing is sent, nothing fails', async () => {
      const { buyer, endpoints } = await orderWithBrowsers(1);
      // The request is in the outbox; the user mutes `orders` before the worker sends.
      await as(buyer.token).put('/me/notification-preferences', {
        preferences: [{ category: 'orders', pushEnabled: false }],
      });
      const pushed = async () =>
        Number(
          (
            await knex()('processed_events')
              .where({ consumer: 'notifications.push' })
              .count<{ count: string }[]>('* as count')
          )[0]?.count,
        );
      const before = await pushed();
      await settle(
        async () => (await pushed()) > before && (await notificationOf(buyer.userId)) !== undefined,
      );
      expect(sender.to(endpoints[0] ?? '')).toEqual([]);
      expect((await notificationOf(buyer.userId))?.push_sent_at).toBeNull();
    });
  });

  describe('session end drops the browsers (NO-8)', () => {
    it('a suspension and a password reset delete every subscription of the user', async () => {
      const admin = await sellerFixtures(t).createActiveAdmin();
      const suspended = await api.customer();
      await register(suspended.token);
      await register(suspended.token);
      expect(
        (
          await request(t.app)
            .post(`${API}/admin/users/${suspended.userId}/suspend`)
            .set('Authorization', `Bearer ${admin.session.accessToken}`)
            .send({ reason: 'fraud report' })
        ).status,
      ).toBe(200);
      await settle(async () => (await endpointsOf(suspended.userId)).length === 0);

      const fx = identityFixtures(t);
      const resetter = await fx.createActive();
      await register(resetter.session.accessToken);
      await request(t.app).post(`${API}/auth/password/forgot`).send({ email: resetter.email });
      const { otp } = await fx.latestSecret(resetter.userId, 'password_reset');
      const reset = await request(t.app)
        .post(`${API}/auth/password/reset`)
        .send({ email: resetter.email, otp, newPassword: NEW_PASSWORD });
      expect(reset.status).toBe(204);
      await settle(async () => (await endpointsOf(resetter.userId)).length === 0);
    });
  });
});
