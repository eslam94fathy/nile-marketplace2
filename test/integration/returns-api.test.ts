import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOVERNORATES_CACHE_KEY } from '../../src/app/delivery/constants';
import { TOKENS } from '../../src/lib/di';
import { type ISecretBox } from '../../src/pkg/crypto';
import { deliveryFixtures } from '../helpers/delivery-fixtures';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { insertReadyMedia } from '../helpers/media';
import { orderFixtures } from '../helpers/order-fixtures';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';
const DAY_MS = 86_400_000;
const CAIRO_FEE = '30.00';

interface ReturnBody {
  id: string;
  returnNumber: string;
  status: string;
  orderNumber: string;
  items: {
    orderItemId: string;
    productName: string;
    quantity: number;
    paidAmount: string;
    restock: boolean | null;
  }[];
  photos: { id: string; urls: { thumb: string } }[];
  returnFee: string;
  returnFeePayer: string;
  refundAmount: string;
  refund?: unknown;
  sellerDecisionDeadlineAt: string | null;
  escalationDeadlineAt: string | null;
  rejectionReason: string | null;
  refusalReason: string | null;
  timeline: { status: string }[];
  payoutMethod?: string | null;
  history?: { from: string | null; to: string; actorRole: string; reason: string | null }[];
}

/*
 * Spec 18 UC-RE-1…UC-RE-5 over HTTP on real Postgres / Redis: the returnable items, the request with
 * its checks, the seller's and admin's decisions, escalation, cancellation and the three views.
 */
describe('returns API', () => {
  let t: TestApp;
  let fx: ReturnType<typeof orderFixtures>;
  let admin: { userId: string; token: string };
  const knex = () => t.infra.db.knex;

  const as = (token: string) => ({
    get: (path: string) => request(t.app).get(`${API}${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}, key: string | null = null) => {
      const req = request(t.app).post(`${API}${path}`).set('Authorization', `Bearer ${token}`);
      return (key ? req.set('Idempotency-Key', key) : req).send(body);
    },
  });

  /**
   * A customer's delivered seller order (1 line 2 × 50.00) delivered `daysAgo` days ago, the customer's
   * and the seller's tokens.
   */
  async function delivered(
    options: { method?: 'cod' | 'kashier'; daysAgo?: number; status?: string; governorateId?: string } = {},
  ) {
    const { customerId, userId } = await fx.insertCustomer();
    const { sellerId, sellerUserId, productId, variantId } = await fx.insertVariantChain();
    const kashier = options.method === 'kashier';
    const orderId = await fx.insertOrder(customerId, {
      payment_method: options.method ?? 'cod',
      payment_expires_at: kashier ? new Date() : null,
      ...(options.governorateId ? { ship_governorate_id: options.governorateId } : {}),
    });
    const status = options.status ?? 'delivered';
    const sellerOrderId = await fx.insertSellerOrder(orderId, sellerId, {
      status,
      delivered_at: status === 'delivered' ? new Date(Date.now() - (options.daysAgo ?? 1) * DAY_MS) : null,
    });
    const orderItemId = await fx.insertOrderItem(sellerOrderId, { variantId, productId });
    return {
      customerId,
      userId,
      sellerId,
      sellerUserId,
      orderId,
      sellerOrderId,
      orderItemId,
      customer: as(await signTestAccessToken({ sub: userId, role: 'customer' })),
      seller: as(await signTestAccessToken({ sub: sellerUserId, role: 'seller' })),
    };
  }
  type Delivered = Awaited<ReturnType<typeof delivered>>;

  const wallet = { method: 'mobile_wallet', walletNumber: '+201001234567' };

  /** POST /returns with a fresh Idempotency-Key. */
  const requestReturn = (d: Delivered, body: Record<string, unknown> = {}) =>
    d.customer.post(
      '/returns',
      {
        sellerOrderId: d.sellerOrderId,
        reason: 'changed_mind',
        items: [{ orderItemId: d.orderItemId, quantity: 1 }],
        refundPayout: wallet,
        ...body,
      },
      randomUUID(),
    );

  async function requested(d: Delivered, body: Record<string, unknown> = {}): Promise<ReturnBody> {
    const res = await requestReturn(d, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return successBody<ReturnBody>(res).data;
  }

  const eventsOf = (returnId: string, type: string) =>
    knex()('events_outbox')
      .where({ event_type: type, aggregate_id: returnId })
      .orderBy('created_at')
      .select<{ payload: Record<string, unknown> }[]>('payload');

  async function setCairoFee(fee: string): Promise<void> {
    await knex()('governorates')
      .where({ id: await fx.governorateId() })
      .update({ delivery_fee: fee });
    await t.infra.cache.delete(GOVERNORATES_CACHE_KEY);
  }

  beforeAll(async () => {
    t = await startTestApp();
    fx = orderFixtures(knex());
    await setCairoFee(CAIRO_FEE);
    const userId = await fx.insertUser('admin');
    admin = { userId, token: await signTestAccessToken({ sub: userId, role: 'admin' }) };
  });
  afterAll(async () => {
    await t.close();
  });

  describe('GET returnable-items', () => {
    it('lists the kept units, the window end and the current fee', async () => {
      const d = await delivered({ daysAgo: 2 });
      const res = await d.customer.get(
        `/orders/${d.orderId}/seller-orders/${d.sellerOrderId}/returnable-items`,
      );
      expect(res.status).toBe(200);
      const body = successBody<{ windowEndsAt: string; items: unknown[]; returnFee: string }>(res).data;
      expect(body.items).toEqual([{ orderItemId: d.orderItemId, returnable: 2, paidUnitAmount: '50.00' }]);
      expect(body.returnFee).toBe(CAIRO_FEE);
      expect(new Date(body.windowEndsAt).getTime()).toBeGreaterThan(Date.now() + 11 * DAY_MS);
    });

    it('answers ORDER_NOT_FOUND, SELLER_ORDER_NOT_FOUND, RETURN_NOT_ALLOWED and RETURN_WINDOW_CLOSED', async () => {
      const d = await delivered();
      const other = await delivered();
      const path = (orderId: string, sellerOrderId: string) =>
        `/orders/${orderId}/seller-orders/${sellerOrderId}/returnable-items`;
      expect(errorBody(await d.customer.get(path(other.orderId, other.sellerOrderId))).error.code).toBe(
        'ORDER_NOT_FOUND',
      );
      expect(errorBody(await d.customer.get(path(d.orderId, other.sellerOrderId))).error.code).toBe(
        'SELLER_ORDER_NOT_FOUND',
      );
      const placed = await delivered({ status: 'placed' });
      expect(
        errorBody(await placed.customer.get(path(placed.orderId, placed.sellerOrderId))).error.code,
      ).toBe('RETURN_NOT_ALLOWED');
      const old = await delivered({ daysAgo: 15 });
      const res = await old.customer.get(path(old.orderId, old.sellerOrderId));
      expect([res.status, errorBody(res).error.code]).toEqual([422, 'RETURN_WINDOW_CLOSED']);
    });

    it('answers RETURN_PICKUP_UNAVAILABLE when the governorate has no fee', async () => {
      const [elsewhere] = await knex()('governorates')
        .whereNot({ id: await fx.governorateId() })
        .whereNull('delivery_fee')
        .select<{ id: string }[]>('id')
        .limit(1);
      if (!elsewhere) throw new Error('no governorate without a fee');
      const d = await delivered({ governorateId: elsewhere.id });
      const res = await d.customer.get(
        `/orders/${d.orderId}/seller-orders/${d.sellerOrderId}/returnable-items`,
      );
      expect([res.status, errorBody(res).error.code]).toEqual([422, 'RETURN_PICKUP_UNAVAILABLE']);
    });
  });

  describe('POST /returns', () => {
    it('creates a changed-mind COD request: fee deducted, payout sealed to the return, event written', async () => {
      const d = await delivered();
      const res = await requestReturn(d, {
        items: [{ orderItemId: d.orderItemId, quantity: 2 }],
        description: 'Too big',
      });
      expect(res.status).toBe(201);
      const body = successBody<ReturnBody>(res).data;
      expect(body).toMatchObject({
        status: 'requested',
        returnFee: CAIRO_FEE,
        returnFeePayer: 'customer',
        refundAmount: '70.00',
        refund: null,
        timeline: [{ status: 'requested' }],
      });
      expect(body.returnNumber).toMatch(/^R-\d{9}$/);
      expect(body.items).toEqual([
        expect.objectContaining({
          orderItemId: d.orderItemId,
          quantity: 2,
          paidAmount: '100.00',
          restock: null,
        }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain('201001234567');

      const [row] = await knex()('return_requests').where({ id: body.id }).select<
        {
          refund_payout_method: string;
          refund_payout_encrypted: string;
          seller_decision_deadline_at: Date;
        }[]
      >('refund_payout_method', 'refund_payout_encrypted', 'seller_decision_deadline_at');
      expect(row?.refund_payout_method).toBe('mobile_wallet');
      expect(row?.refund_payout_encrypted).not.toContain('2010');
      const box = t.container.resolve<ISecretBox>(TOKENS.SecretBox);
      expect(JSON.parse(box.open(row?.refund_payout_encrypted ?? '', `${body.id}:refund_payout`))).toEqual(
        wallet,
      );
      expect(() => box.open(row?.refund_payout_encrypted ?? '', `${UNKNOWN_ID}:refund_payout`)).toThrow();
      expect(row?.seller_decision_deadline_at.getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);

      const [event] = await eventsOf(body.id, 'return.status_changed');
      expect(event?.payload).toMatchObject({
        returnId: body.id,
        orderNumber: body.orderNumber,
        customerId: d.customerId,
        sellerId: d.sellerId,
        from: null,
        to: 'requested',
        actor: 'customer',
      });
    });

    it('a seller-fault request needs a photo of the caller; the seller pays the fee', async () => {
      const d = await delivered();
      const noPhoto = await requestReturn(d, { reason: 'damaged' });
      expect([noPhoto.status, errorBody(noPhoto).error.code]).toEqual([422, 'RETURN_PHOTOS_REQUIRED']);
      const someoneElses = await insertReadyMedia(t, (await fx.insertCustomer()).userId, 'return_photo');
      const foreign = await requestReturn(d, { reason: 'damaged', photoMediaIds: [someoneElses] });
      expect([foreign.status, errorBody(foreign).error.code]).toEqual([422, 'MEDIA_NOT_ATTACHABLE']);

      const photo = await insertReadyMedia(t, d.userId, 'return_photo');
      const body = await requested(d, { reason: 'damaged', photoMediaIds: [photo] });
      expect(body).toMatchObject({ returnFeePayer: 'seller', refundAmount: '50.00' });
      expect(body.photos.map((p) => p.id)).toEqual([photo]);
      const [media] = await knex()('media_objects')
        .where({ id: photo })
        .select<{ claimed_at: Date | null }[]>('claimed_at');
      expect(media?.claimed_at).toBeInstanceOf(Date);
    });

    it('checks the payout details against the payment method (400) and the body shape', async () => {
      const cod = await delivered();
      const missing = await requestReturn(cod, { refundPayout: undefined });
      expect([missing.status, errorBody(missing).error.details?.[0]?.constraint]).toEqual([
        400,
        'required_for_cod',
      ]);
      const mixed = await requestReturn(cod, {
        refundPayout: { ...wallet, instapayAddress: 'mona@instapay' },
      });
      expect([mixed.status, errorBody(mixed).error.details?.[0]?.field]).toEqual([
        400,
        'refundPayout.instapayAddress',
      ]);
      const noKey = await cod.customer.post('/returns', { sellerOrderId: cod.sellerOrderId });
      expect(errorBody(noKey).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

      const kashier = await delivered({ method: 'kashier' });
      const sent = await requestReturn(kashier);
      expect([sent.status, errorBody(sent).error.details?.[0]?.constraint]).toEqual([
        400,
        'not_allowed_for_online_payment',
      ]);
      expect((await requested(kashier, { refundPayout: undefined })).refundAmount).toBe('20.00');
    });

    it('refuses quantities over what was kept, a fee that eats the refund, and a second open return', async () => {
      const d = await delivered();
      const tooMany = await requestReturn(d, { items: [{ orderItemId: d.orderItemId, quantity: 3 }] });
      expect([tooMany.status, errorBody(tooMany).error.code]).toEqual([422, 'RETURN_QUANTITY_INVALID']);
      // 1 × 50.00 back, fee 50.00: nothing left to refund. The fees are cached, so drop the entry.
      await setCairoFee('50.00');
      const tooLow = await requestReturn(await delivered());
      expect([tooLow.status, errorBody(tooLow).error.code]).toEqual([422, 'RETURN_AMOUNT_TOO_LOW']);
      await setCairoFee(CAIRO_FEE);

      const results = await Promise.all([requestReturn(d), requestReturn(d)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.map((r) => (r.status === 409 ? errorBody(r).error.code : null))).toContain(
        'RETURN_ALREADY_OPEN',
      );
    });
  });

  describe('decisions', () => {
    it('the seller approves: approved, and return.approved carries both snapshots and the fee', async () => {
      const d = await delivered();
      const created = await requested(d, { items: [{ orderItemId: d.orderItemId, quantity: 2 }] });
      const res = await d.seller.post(`/seller/returns/${created.id}/approve`);
      expect(res.status).toBe(200);
      expect(successBody<ReturnBody>(res).data).not.toHaveProperty('refund');
      expect(successBody<ReturnBody>(res).data.status).toBe('approved');
      const [approved] = await eventsOf(created.id, 'return.approved');
      expect(approved?.payload).toMatchObject({
        returnId: created.id,
        sellerOrderId: d.sellerOrderId,
        itemCount: 2,
        returnFee: CAIRO_FEE,
        agentShareRate: expect.stringMatching(/^0\.\d{4}$/) as unknown,
        pickup: { recipientName: 'Mona Ali', street: 'Road 9' },
        dropoff: { phone: '+201221234567', street: 'Street' },
      });
      expect(((approved?.payload.dropoff ?? {}) as { businessName?: string }).businessName).toMatch(/^Shop /);
      const again = await d.seller.post(`/seller/returns/${created.id}/approve`);
      expect([again.status, errorBody(again).error.code]).toEqual([409, 'RETURN_INVALID_STATUS_TRANSITION']);
      const stranger = await delivered();
      expect((await stranger.seller.post(`/seller/returns/${created.id}/approve`)).status).toBe(404);
    });

    it('the seller rejects, the customer escalates in time, an admin approves (audited)', async () => {
      const d = await delivered();
      const created = await requested(d);
      const rejected = successBody<ReturnBody>(
        await d.seller.post(`/seller/returns/${created.id}/reject`, { reason: 'Item was used' }),
      ).data;
      expect(rejected).toMatchObject({ status: 'rejected', rejectionReason: 'Item was used' });
      expect(new Date(rejected.escalationDeadlineAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 6 * DAY_MS);

      const escalated = await d.customer.post(`/returns/${created.id}/escalate`, { note: 'It was not used' });
      expect(successBody<ReturnBody>(escalated).data.status).toBe('escalated');
      const decided = await as(admin.token).post(`/admin/returns/${created.id}/decide`, {
        decision: 'approve',
        note: 'Photos show it unused',
      });
      expect(decided.status).toBe(200);
      const body = successBody<ReturnBody>(decided).data;
      expect(body.status).toBe('approved');
      expect(body.history?.map((h) => [h.from, h.to, h.actorRole, h.reason])).toEqual([
        [null, 'requested', 'customer', null],
        ['requested', 'rejected', 'seller', 'Item was used'],
        ['rejected', 'escalated', 'customer', 'It was not used'],
        ['escalated', 'approved', 'admin', 'Photos show it unused'],
      ]);
      const [audit] = await knex()('admin_audit_log')
        .where({ action: 'return.admin_decided', target_id: created.id })
        .select<{ target_type: string; changes: unknown; reason: string }[]>(
          'target_type',
          'changes',
          'reason',
        );
      expect(audit).toEqual({
        target_type: 'return_request',
        changes: { before: { status: 'escalated' }, after: { status: 'approved' } },
        reason: 'Photos show it unused',
      });
      expect(await eventsOf(created.id, 'return.approved')).toHaveLength(1);
    });

    it('an admin rejection refuses the return for good and clears the payout details', async () => {
      const d = await delivered();
      const created = await requested(d);
      const res = await as(admin.token).post(`/admin/returns/${created.id}/decide`, {
        decision: 'reject',
        note: 'Abuse',
      });
      expect(successBody<ReturnBody>(res).data).toMatchObject({
        status: 'refused',
        refusalReason: 'admin_rejected',
        payoutMethod: 'mobile_wallet',
      });
      const [row] = await knex()('return_requests')
        .where({ id: created.id })
        .select<{ refund_payout_encrypted: string | null }[]>('refund_payout_encrypted');
      expect(row).toEqual({ refund_payout_encrypted: null });
      const again = await as(admin.token).post(`/admin/returns/${created.id}/decide`, {
        decision: 'approve',
        note: 'Oops',
      });
      expect(errorBody(again).error.code).toBe('RETURN_INVALID_STATUS_TRANSITION');
    });

    it('escalation after the deadline is refused', async () => {
      const d = await delivered();
      const created = await requested(d);
      await d.seller.post(`/seller/returns/${created.id}/reject`, { reason: 'Item was used' });
      await knex()('return_requests')
        .where({ id: created.id })
        .update({ escalation_deadline_at: new Date(Date.now() - 1000) });
      const res = await d.customer.post(`/returns/${created.id}/escalate`, { note: 'Please' });
      expect([res.status, errorBody(res).error.code]).toEqual([409, 'RETURN_ESCALATION_WINDOW_CLOSED']);
    });
  });

  describe('cancel', () => {
    it('cancels before pickup: photos released, payout cleared, a new request allowed', async () => {
      const d = await delivered();
      const photo = await insertReadyMedia(t, d.userId, 'return_photo');
      const created = await requested(d, { reason: 'damaged', photoMediaIds: [photo] });
      await d.seller.post(`/seller/returns/${created.id}/approve`);
      const res = await d.customer.post(`/returns/${created.id}/cancel`);
      expect(successBody<ReturnBody>(res).data).toMatchObject({ status: 'cancelled', photos: [] });
      const [media] = await knex()('media_objects')
        .where({ id: photo })
        .select<{ released_at: Date | null }[]>('released_at');
      expect(media?.released_at).toBeInstanceOf(Date);
      const [row] = await knex()('return_requests')
        .where({ id: created.id })
        .select<{ refund_payout_encrypted: string | null }[]>('refund_payout_encrypted');
      expect(row).toEqual({ refund_payout_encrypted: null });
      const [event] = (await eventsOf(created.id, 'return.status_changed')).slice(-1);
      expect(event?.payload).toMatchObject({ from: 'approved', to: 'cancelled', actor: 'customer' });
      await requested(d);
    });

    it('an agent who already picked the parcel up wins (409); another customer sees nothing (404)', async () => {
      const d = await delivered();
      const created = await requested(d);
      const stranger = await delivered();
      expect(errorBody(await stranger.customer.post(`/returns/${created.id}/cancel`)).error.code).toBe(
        'RETURN_NOT_FOUND',
      );
      await d.seller.post(`/seller/returns/${created.id}/approve`);
      const { agentId } = await deliveryFixtures(knex()).insertAgent();
      await knex()('return_requests')
        .where({ id: created.id })
        .update({ status: 'picked_up', agent_id: agentId });
      const res = await d.customer.post(`/returns/${created.id}/cancel`);
      expect([res.status, errorBody(res).error.code]).toEqual([409, 'RETURN_INVALID_STATUS_TRANSITION']);
    });
  });

  describe('views', () => {
    it('each party lists its own returns; admins filter by customer; roles are kept apart', async () => {
      const d = await delivered();
      const first = await requested(d);
      await d.customer.post(`/returns/${first.id}/cancel`);
      const second = await requested(d);
      const other = await delivered();
      await requested(other);

      const mine = successBody<ReturnBody[]>(await d.customer.get('/returns')).data;
      expect(mine.map((r) => r.id)).toEqual([second.id, first.id]);
      const open = successBody<ReturnBody[]>(await d.customer.get('/returns?status[eq]=requested')).data;
      expect(open.map((r) => r.id)).toEqual([second.id]);

      const queue = successBody<ReturnBody[]>(
        await d.seller.get('/seller/returns?status[eq]=requested&sort=sellerDecisionDeadlineAt'),
      ).data;
      expect(queue.map((r) => r.id)).toEqual([second.id]);
      expect(queue[0]).not.toHaveProperty('refund');

      const byCustomer = successBody<ReturnBody[]>(
        await as(admin.token).get(`/admin/returns?customerId[eq]=${d.customerId}&limit=1`),
      );
      expect(byCustomer.data.map((r) => r.id)).toEqual([second.id]);
      expect(byCustomer.meta?.hasMore).toBe(true);

      expect((await d.seller.get(`/returns/${second.id}`)).status).toBe(403);
      expect(errorBody(await other.customer.get(`/returns/${second.id}`)).error.code).toBe(
        'RETURN_NOT_FOUND',
      );
      expect(errorBody(await other.seller.get(`/seller/returns/${second.id}`)).error.code).toBe(
        'RETURN_NOT_FOUND',
      );
      expect((await as(admin.token).get(`/admin/returns/${UNKNOWN_ID}`)).status).toBe(404);
    });
  });
});
