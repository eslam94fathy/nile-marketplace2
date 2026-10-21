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
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { createMemoryLogger } from '../helpers/memory-logger';
import { orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

interface AdminProduct {
  id: string;
  sellerId: string;
  status: string;
  visible: boolean;
  adminBlocked: boolean;
  adminBlockReason: string | null;
}

/* Spec 20 §3.4 (BO-6, BO-14…BO-16): the admin product block and unblock. */
describe('admin product block', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let worker: WorkerInfrastructure;
  let adminToken: string;
  let adminUserId: string;
  const knex = () => t.infra.db.knex;

  const asAdmin = (method: 'get' | 'post', path: string, body?: object) =>
    request(t.app)[method](`${API}${path}`).set('Authorization', `Bearer ${adminToken}`).send(body);
  const block = (productId: string, reason = 'Prohibited item') =>
    asAdmin('post', `/admin/products/${productId}/block`, { reason });
  const unblock = (productId: string) => asAdmin('post', `/admin/products/${productId}/unblock`);

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
    adminUserId = await api.fx.insertUser('admin');
    adminToken = await signTestAccessToken({ sub: adminUserId, role: 'admin' });
    const { logger } = createMemoryLogger();
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
  });
  afterAll(async () => {
    await closeInfrastructure(worker);
    await t.close();
  });

  it('blocks an active product: off the shop, not purchasable, event and audit row', async () => {
    const listed = await api.listedVariant();
    const res = await block(listed.productId);
    expect(res.status).toBe(200);
    expect(successBody<AdminProduct>(res).data).toMatchObject({
      id: listed.productId,
      sellerId: listed.sellerId,
      status: 'inactive',
      visible: false,
      adminBlocked: true,
      adminBlockReason: 'Prohibited item',
    });

    expect((await request(t.app).get(`${API}/products/${listed.productId}`)).status).toBe(404);
    const buyer = await api.customer();
    await api.fillCart(buyer.customerId, [{ variantId: listed.variantId, quantity: 1 }]);
    const checkout = await api.as(buyer.token).checkout({
      addressId: buyer.addressId,
      paymentMethod: 'cod',
      expectedTotal: '150.00',
    });
    expect(checkout.status).toBe(409);
    expect(errorBody(checkout).error.code).toBe('CART_HAS_ISSUES');

    expect(await api.eventsOf('product.blocked', listed.productId)).toEqual([
      { productId: listed.productId, sellerId: listed.sellerId, at: expect.any(String) as unknown },
    ]);
    const audit = await knex()('admin_audit_log')
      .where({ target_type: 'product', target_id: listed.productId })
      .select<{ action: string; actor_user_id: string; reason: string | null; changes: unknown }[]>(
        'action',
        'actor_user_id',
        'reason',
        'changes',
      );
    expect(audit).toEqual([
      {
        action: 'product.blocked',
        actor_user_id: adminUserId,
        reason: 'Prohibited item',
        changes: { before: { adminBlocked: false }, after: { adminBlocked: true } },
      },
    ]);

    const again = await block(listed.productId);
    expect(again.status).toBe(409);
    expect(errorBody(again).error.code).toBe('PRODUCT_BLOCK_INVALID_STATUS');
  });

  it('the seller sees the block, may edit but not activate; unblock leaves it inactive (BO-15, BO-16)', async () => {
    const listed = await api.listedVariant();
    const seller = (method: 'get' | 'post' | 'patch', path: string, body?: object) =>
      request(t.app)[method](`${API}${path}`).set('Authorization', `Bearer ${listed.sellerToken}`).send(body);
    expect((await block(listed.productId, 'Counterfeit listing')).status).toBe(200);

    const mine = await seller('get', `/seller/products/${listed.productId}`);
    expect(successBody<AdminProduct>(mine).data).toMatchObject({
      adminBlocked: true,
      adminBlockReason: 'Counterfeit listing',
    });
    expect(
      (await seller('patch', `/seller/products/${listed.productId}`, { name: 'Fixed name' })).status,
    ).toBe(200);
    const activate = await seller('post', `/seller/products/${listed.productId}/activate`);
    expect(activate.status).toBe(409);
    expect(errorBody(activate).error.code).toBe('PRODUCT_BLOCKED');

    const res = await unblock(listed.productId);
    expect(res.status).toBe(200);
    expect(successBody<AdminProduct>(res).data).toMatchObject({
      status: 'inactive',
      adminBlocked: false,
      adminBlockReason: null,
    });
    expect(await api.eventsOf('product.unblocked', listed.productId)).toHaveLength(1);
    expect((await seller('post', `/seller/products/${listed.productId}/activate`)).status).toBe(200);
    expect((await unblock(listed.productId)).status).toBe(409);
  });

  it('a draft stays a draft when blocked (BO-16)', async () => {
    const listed = await api.listedVariant();
    await knex()('products').where({ id: listed.productId }).update({ status: 'draft', published_at: null });
    const res = await block(listed.productId);
    expect(successBody<AdminProduct>(res).data).toMatchObject({ status: 'draft', adminBlocked: true });
  });

  it('notifies the seller of a block (NO-33)', async () => {
    const listed = await api.listedVariant();
    expect((await block(listed.productId)).status).toBe(200);
    const [row] = await knex()('events_outbox')
      .where({ event_type: 'product.blocked', aggregate_id: listed.productId })
      .select<{ id: string; payload: Record<string, unknown> }[]>('id', 'payload');
    const envelope: EventEnvelope = {
      eventId: row?.id ?? '',
      eventType: 'product.blocked',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      aggregateType: 'product',
      aggregateId: listed.productId,
      payload: row?.payload ?? {},
    };
    const service = createWorkerContainer(worker).resolve<UserEventsService>(TOKENS.UserEventsService);
    const prepared = await service.prepare(envelope);
    await worker.db.run((trx) => service.record(prepared, trx));
    const notifications = await knex()('user_notifications')
      .where({ source_event_id: envelope.eventId })
      .select<{ user_id: string; category: string; type: string; title: string; link: string }[]>(
        'user_id',
        'category',
        'type',
        'title',
        'link',
      );
    expect(notifications).toEqual([
      {
        user_id: listed.sellerUserId,
        category: 'orders',
        type: 'product_blocked',
        title: 'Product blocked',
        link: `/seller/products/${listed.productId}`,
      },
    ]);
  });

  it('validation, 404 for unknown or deleted products, 403 for other roles', async () => {
    const listed = await api.listedVariant();
    expect((await block(listed.productId, 'ab')).status).toBe(400);
    expect((await asAdmin('post', `/admin/products/${listed.productId}/block`, {})).status).toBe(400);
    expect(
      (
        await asAdmin('post', `/admin/products/${listed.productId}/block`, {
          reason: 'Prohibited item',
          extra: 1,
        })
      ).status,
    ).toBe(400);
    const unknown = '0192f5e0-0000-7000-8000-000000000000';
    const missing = await block(unknown);
    expect(missing.status).toBe(404);
    expect(errorBody(missing).error.code).toBe('PRODUCT_NOT_FOUND');
    expect((await asAdmin('get', `/admin/products/${unknown}`)).status).toBe(404);

    await knex()('products').where({ id: listed.productId }).update({ deleted_at: new Date() });
    expect((await block(listed.productId)).status).toBe(404);
    expect((await asAdmin('get', `/admin/products/${listed.productId}`)).status).toBe(404);

    const other = await api.listedVariant();
    const asSeller = await request(t.app)
      .post(`${API}/admin/products/${other.productId}/block`)
      .set('Authorization', `Bearer ${other.sellerToken}`)
      .send({ reason: 'Prohibited item' });
    expect(asSeller.status).toBe(403);
  });
});
