import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { type EventEnvelope, type EventHandlerDefinition } from '../../src/lib/events';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { createMemoryLogger } from '../helpers/memory-logger';
import { orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

interface AdminOrder {
  id: string;
  status: string;
  sellerOrders: {
    id: string;
    status: string;
    cancelReason: string | null;
    statusHistory: { reason: string | null }[];
  }[];
}

/*
 * Spec 09 §8.4 (UC-OR-9, UC-OR-10): an admin cancels a seller order or a whole order, all or nothing,
 * with the seller-cancel effects, an audit row, and a refund flagged for a paid Kashier order.
 */
describe('admin order cancellation', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let worker: WorkerInfrastructure;
  let handlers: EventHandlerDefinition[];
  let admin: { userId: string; token: string };
  const knex = () => t.infra.db.knex;

  const cancel = (
    path: string,
    body: object = { reason: 'Fraudulent order' },
    key: string | null = randomUUID(),
  ) => {
    const req = request(t.app).post(`${API}${path}`).set('Authorization', `Bearer ${admin.token}`);
    return (key ? req.set('Idempotency-Key', key) : req).send(body);
  };

  /** A COD order of one buyer with one seller order per listed variant. */
  async function placed(sellers = 1) {
    const buyer = await api.customer();
    const variants = [];
    for (let i = 0; i < sellers; i += 1) variants.push(await api.listedVariant({ price: '100.00' }));
    const total = (100 * sellers + 50).toFixed(2);
    const { order } = await api.placeOrder(
      buyer,
      variants.map((v) => ({ variantId: v.variantId, quantity: 1 })),
      total,
    );
    return { buyer, variants, order };
  }

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
    const userId = await api.fx.insertUser('admin');
    admin = { userId, token: await signTestAccessToken({ sub: userId, role: 'admin' }) };
    const { logger } = createMemoryLogger();
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    handlers = createEventHandlers(createWorkerContainer(worker));
  });
  afterAll(async () => {
    await closeInfrastructure(worker);
    await t.close();
  });

  it('cancels one seller order: stock released, event, admin-only reason, audit row', async () => {
    const { buyer, variants, order } = await placed();
    const sellerOrderId = order.sellerOrders[0]?.id ?? '';
    const res = await cancel(`/admin/seller-orders/${sellerOrderId}/cancel`);
    expect(res.status).toBe(200);
    const detail = successBody<AdminOrder>(res).data;
    expect(detail.sellerOrders[0]).toMatchObject({ status: 'cancelled', cancelReason: 'admin_cancelled' });
    expect(detail.sellerOrders[0]?.statusHistory.at(-1)?.reason).toBe('Fraudulent order');
    expect(detail.status).toBe('cancelled');

    expect(await api.stockOf(variants[0]?.variantId ?? '')).toEqual({ on_hand: 10, reserved: 0 });
    expect(await api.eventsOf('seller_order.cancelled', sellerOrderId)).toEqual([
      expect.objectContaining({ reason: 'admin_cancelled', previousStatus: 'placed' }),
    ]);
    const audit = await knex()('admin_audit_log')
      .where({ target_type: 'seller_order', target_id: sellerOrderId })
      .first<{ action: string; actor_user_id: string; reason: string; changes: unknown }>(
        'action',
        'actor_user_id',
        'reason',
        'changes',
      );
    expect(audit).toEqual({
      action: 'seller_order.admin_cancelled',
      actor_user_id: admin.userId,
      reason: 'Fraudulent order',
      changes: { before: { status: 'placed' }, after: { status: 'cancelled' } },
    });

    // The customer sees the code, never the admin's text (OR-19).
    const mine = await request(t.app)
      .get(`${API}/orders/${order.id}`)
      .set('Authorization', `Bearer ${buyer.token}`);
    expect(JSON.stringify(mine.body)).toContain('admin_cancelled');
    expect(JSON.stringify(mine.body)).not.toContain('Fraudulent');

    const again = await cancel(`/admin/seller-orders/${sellerOrderId}/cancel`);
    expect(again.status).toBe(409);
    expect(errorBody(again).error.code).toBe('SELLER_ORDER_NOT_CANCELLABLE');
  });

  it('cancels a whole order from placed and ready_for_pickup; all or nothing when one is past it (OR-17)', async () => {
    const { variants, order } = await placed(2);
    const [first, second] = order.sellerOrders;
    const sellerOf = (sellerOrderId: string) => {
      const so = order.sellerOrders.find((s) => s.id === sellerOrderId);
      return variants.find((v) => v.sellerId === so?.sellerId);
    };
    for (const step of ['accept', 'ready']) {
      const res = await request(t.app)
        .post(`${API}/seller/orders/${first?.id ?? ''}/${step}`)
        .set('Authorization', `Bearer ${sellerOf(first?.id ?? '')?.sellerToken ?? ''}`);
      expect(res.status, step).toBe(200);
    }
    // Picked up: past the admin's window.
    await knex()('seller_orders').where({ id: second?.id }).update({ status: 'picked_up' });
    const blocked = await cancel(`/admin/orders/${order.id}/cancel`);
    expect(blocked.status).toBe(409);
    expect(errorBody(blocked).error.code).toBe('ORDER_NOT_CANCELLABLE');
    expect(errorBody(blocked).error.details?.map((d) => d.value)).toEqual([second?.id]);
    const unchanged = await knex()('seller_orders').where({ order_id: order.id }).pluck<string[]>('status');
    expect(unchanged.sort()).toEqual(['picked_up', 'ready_for_pickup']);

    await knex()('seller_orders').where({ id: second?.id }).update({ status: 'accepted' });
    const res = await cancel(`/admin/orders/${order.id}/cancel`, { reason: 'Customer fraud report' });
    expect(res.status).toBe(200);
    expect(successBody<AdminOrder>(res).data).toMatchObject({ status: 'cancelled' });
    expect(successBody<AdminOrder>(res).data.sellerOrders.map((s) => s.cancelReason)).toEqual([
      'admin_cancelled',
      'admin_cancelled',
    ]);
    const audit = await knex()('admin_audit_log')
      .where({ target_type: 'order', target_id: order.id })
      .pluck<string[]>('action');
    expect(audit).toEqual(['order.admin_cancelled']);
    const nothingOpen = await cancel(`/admin/orders/${order.id}/cancel`);
    expect(nothingOpen.status).toBe(409);
    expect(errorBody(nothingOpen).error.details ?? []).toEqual([]);
  });

  it('a paid Kashier order gets its refund flagged by the existing payments consumer', async () => {
    const { order } = await placed();
    await knex()('orders')
      .where({ id: order.id })
      .update({ payment_method: 'kashier', payment_expires_at: new Date(Date.now() + 900_000) });
    await knex()('payments')
      .where({ order_id: order.id })
      .update({
        method: 'kashier',
        status: 'paid',
        collected_amount: '150.00',
        provider_order_ref: randomUUID(),
        // The session columns come together (chk_payments_session_columns).
        provider_session_url: 'https://checkout.example/session',
        provider_session_expires_at: new Date(Date.now() + 900_000),
        provider_transaction_ref: `TX-${randomUUID().slice(0, 8)}`,
        paid_at: new Date(),
      });
    const sellerOrderId = order.sellerOrders[0]?.id ?? '';
    expect((await cancel(`/admin/seller-orders/${sellerOrderId}/cancel`)).status).toBe(200);

    const [row] = await knex()('events_outbox')
      .where({ event_type: 'seller_order.cancelled', aggregate_id: sellerOrderId })
      .select<
        {
          id: string;
          event_type: string;
          aggregate_type: string;
          aggregate_id: string;
          payload: Record<string, unknown>;
        }[]
      >('id', 'event_type', 'aggregate_type', 'aggregate_id', 'payload');
    const envelope: EventEnvelope = {
      eventId: row?.id ?? '',
      eventType: 'seller_order.cancelled',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      aggregateType: row?.aggregate_type ?? '',
      aggregateId: sellerOrderId,
      payload: row?.payload ?? {},
    };
    const payments = handlers.find((h) => h.name === 'payments.order-adjustments');
    if (!payments) throw new Error('no payments.order-adjustments handler');
    await worker.db.knex.transaction((trx) => payments.handle(envelope, trx, undefined));
    const refunds = await knex()('payment_refunds')
      .join('payments', 'payments.id', 'payment_refunds.payment_id')
      .where('payments.order_id', order.id)
      .select<{ reason: string; status: string; amount: string }[]>(
        'payment_refunds.reason',
        'payment_refunds.status',
        'payment_refunds.amount',
      );
    expect(refunds).toEqual([{ reason: 'seller_order_cancelled', status: 'pending_auto', amount: '100.00' }]);
  });

  it('requires an Idempotency-Key and a reason; 404 unknown; 403 for other roles; pending payment is 409', async () => {
    const { buyer, order } = await placed();
    const sellerOrderId = order.sellerOrders[0]?.id ?? '';
    expect(
      (await cancel(`/admin/seller-orders/${sellerOrderId}/cancel`, { reason: 'ok' }, null)).status,
    ).toBe(400);
    expect((await cancel(`/admin/seller-orders/${sellerOrderId}/cancel`, { reason: 'ab' })).status).toBe(400);
    expect((await cancel(`/admin/seller-orders/${sellerOrderId}/cancel`, {})).status).toBe(400);
    expect((await cancel(`/admin/seller-orders/${randomUUID()}/cancel`)).status).toBe(400); // not a v7 uuid
    const unknown = await cancel('/admin/seller-orders/0192f5e0-0000-7000-8000-000000000000/cancel');
    expect(unknown.status).toBe(404);
    expect(errorBody(unknown).error.code).toBe('SELLER_ORDER_NOT_FOUND');
    expect((await cancel('/admin/orders/0192f5e0-0000-7000-8000-000000000000/cancel')).status).toBe(404);
    const asCustomer = await request(t.app)
      .post(`${API}/admin/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${buyer.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Fraudulent order' });
    expect(asCustomer.status).toBe(403);

    await knex()('seller_orders').where({ id: sellerOrderId }).update({ status: 'pending_payment' });
    const pending = await cancel(`/admin/seller-orders/${sellerOrderId}/cancel`);
    expect(pending.status).toBe(409);
    expect(errorBody(pending).error.code).toBe('SELLER_ORDER_NOT_CANCELLABLE');
  });
});
