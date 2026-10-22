import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type UserEventsService } from '../../src/app/notifications/service/user-events.service';
import { createWorkerContainer } from '../../src/container';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { TOKENS } from '../../src/lib/di';
import { type EventEnvelope } from '../../src/lib/events';
import { successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { createMemoryLogger } from '../helpers/memory-logger';
import { orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

const DAY = 86_400_000;

/* Spec 13 NO-35, spec 19 PR-20: the seller hears that an admin blocked one of their coupons. */
describe('coupon block notification', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let worker: WorkerInfrastructure;
  let adminToken: string;
  const knex = () => t.infra.db.knex;

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
    adminToken = await signTestAccessToken({ sub: await api.fx.insertUser('admin'), role: 'admin' });
    const { logger } = createMemoryLogger();
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
  });
  afterAll(async () => {
    await closeInfrastructure(worker);
    await t.close();
  });

  it('notifies the seller in-app under orders, linking to the coupon', async () => {
    const { sellerId, userId } = await api.fx.insertSeller();
    const sellerToken = await signTestAccessToken({ sub: userId, role: 'seller' });
    const created = await request(t.app)
      .post(`${API}/seller/coupons`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({
        code: `BLK-${Date.now().toString(36)}`.toUpperCase(),
        discountType: 'percent',
        discountValue: '0.10',
        minItemsSubtotal: '0.00',
        scope: 'seller',
        startsAt: new Date(Date.now() - DAY).toISOString(),
        endsAt: new Date(Date.now() + DAY).toISOString(),
        perCustomerLimit: 1,
      });
    const couponId = successBody<{ id: string }>(created).data.id;
    const blocked = await request(t.app)
      .post(`${API}/admin/coupons/${couponId}/block`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Misleading code' });
    expect(blocked.status).toBe(200);

    const [row] = await knex()('events_outbox')
      .where({ event_type: 'coupon.blocked', aggregate_id: couponId })
      .select<{ id: string; payload: Record<string, unknown> }[]>('id', 'payload');
    expect(row?.payload).toMatchObject({ couponId, sellerId });
    const envelope: EventEnvelope = {
      eventId: row?.id ?? '',
      eventType: 'coupon.blocked',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      aggregateType: 'coupon',
      aggregateId: couponId,
      payload: row?.payload ?? {},
    };
    const service = createWorkerContainer(worker).resolve<UserEventsService>(TOKENS.UserEventsService);
    await worker.db.run(async (trx) => service.record(await service.prepare(envelope), trx));
    const notifications = await knex()('user_notifications')
      .where({ source_event_id: envelope.eventId })
      .select<
        { user_id: string; category: string; type: string; title: string; body: string; link: string }[]
      >('user_id', 'category', 'type', 'title', 'body', 'link');
    expect(notifications).toEqual([
      {
        user_id: userId,
        category: 'orders',
        type: 'coupon_blocked',
        title: 'Coupon blocked',
        body: 'One of your coupons was blocked by the platform.',
        link: `/seller/coupons/${couponId}`,
      },
    ]);
  });
});
