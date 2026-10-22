import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IPaymentDirectory } from '../../src/app/payments';
import { type AdminPaymentDto, type RefundDto } from '../../src/app/payments/dto/payment-admin.dto';
import { TOKENS } from '../../src/lib/di';
import { type FakePaymentGateway, signKashierWebhook } from '../../src/pkg/payments';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { orderFixtures } from '../helpers/order-fixtures';
import { TEST_KASHIER_API_KEY } from '../helpers/test-env';
import { startTestApp, type TestApp } from '../helpers/test-app';

/** Route ids must be UUID v7 (UuidField); this one exists nowhere. */
const UNKNOWN_V7_ID = '0192f5e0-0000-7000-8000-000000000000';
const SIGNATURE_KEYS = ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId'];

/* Spec 10 UC-PA-1, UC-PA-2, UC-PA-4 and the Kashier part of §2, with the fake gateway (PA-5). */
describe('payments: Kashier sessions, webhook and manual refunds', () => {
  let t: TestApp;
  let fx: ReturnType<typeof orderFixtures>;
  let gateway: FakePaymentGateway;
  let directory: IPaymentDirectory;
  let adminToken: string;
  let adminUserId: string;

  const knex = () => t.infra.db.knex;
  const paymentRow = (id: string) =>
    knex()('payments').where({ id }).first<{
      status: string;
      collected_amount: string;
      refunded_amount: string;
      provider_order_ref: string | null;
      provider_transaction_ref: string | null;
    }>('status', 'collected_amount', 'refunded_amount', 'provider_order_ref', 'provider_transaction_ref');
  const outboxOf = (eventType: string, aggregateId: string) =>
    knex()('events_outbox')
      .where({ event_type: eventType, aggregate_id: aggregateId })
      .select<{ payload: Record<string, unknown> }[]>('payload');

  /** A Kashier order of 150.00 with its payment in `status` (initiated by default). */
  async function kashierPayment(status = 'initiated') {
    const { customerId } = await fx.insertCustomer();
    const orderId = await fx.insertOrder(customerId, {
      status: 'pending_payment',
      payment_method: 'kashier',
      payment_expires_at: new Date(Date.now() + 15 * 60_000),
      placed_at: null,
    });
    const paymentId = await fx.insertPayment(orderId, { method: 'kashier', status });
    return { orderId, paymentId };
  }

  /** POSTs a Kashier-signed webhook (or one signed with `key`) for `merchantOrderId`. */
  function postWebhook(
    data: Record<string, unknown>,
    options: { event?: string; key?: string; signature?: string | null } = {},
  ) {
    const full = { signatureKeys: SIGNATURE_KEYS, currency: 'EGP', status: 'SUCCESS', amount: 150, ...data };
    const body = JSON.stringify({ event: options.event ?? 'pay', data: full });
    const signature =
      options.signature === undefined
        ? signKashierWebhook(full, SIGNATURE_KEYS, options.key ?? TEST_KASHIER_API_KEY)
        : options.signature;
    const req = request(t.app).post(`${API}/webhooks/kashier`).set('Content-Type', 'application/json');
    return (signature ? req.set('x-kashier-signature', signature) : req).send(body);
  }

  beforeAll(async () => {
    t = await startTestApp();
    fx = orderFixtures(knex());
    gateway = t.infra.paymentGateway as FakePaymentGateway;
    directory = t.container.resolve<IPaymentDirectory>(TOKENS.PaymentDirectory);
    adminUserId = await fx.insertUser('admin');
    adminToken = await signTestAccessToken({ sub: adminUserId, role: 'admin' });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('createKashierSession (PA-3, PA-12)', () => {
    const window = () => ({ expiresAt: new Date(Date.now() + 15 * 60_000), description: 'Nile order' });

    it('creates and stores one session, then hands the stored one back', async () => {
      const { orderId, paymentId } = await kashierPayment();
      const before = gateway.createCalls;
      const first = await directory.createKashierSession(orderId, window());
      expect(first.kind).toBe('session');
      expect(first.kind === 'session' ? first.checkoutUrl : '').toMatch(
        /^https:\/\/fake-kashier\.invalid\/session\//,
      );
      expect(await directory.createKashierSession(orderId, window())).toEqual(first);
      expect(gateway.createCalls - before).toBe(1);
      expect((await paymentRow(paymentId))?.provider_order_ref).not.toBeNull();
    });

    it('two parallel requests end with one session for both', async () => {
      const { orderId } = await kashierPayment();
      const [a, b] = await Promise.all([
        directory.createKashierSession(orderId, window()),
        directory.createKashierSession(orderId, window()),
      ]);
      expect(a).toEqual(b);
      expect(a.kind).toBe('session');
    });

    it('a payment that is not awaiting payment gets no session', async () => {
      const paid = await kashierPayment('paid');
      expect(await directory.createKashierSession(paid.orderId, window())).toEqual({
        kind: 'not_awaiting_payment',
      });
      expect(await directory.createKashierSession(randomUUID(), window())).toEqual({
        kind: 'not_awaiting_payment',
      });
    });

    it('PAYMENT_PROVIDER_UNAVAILABLE when Kashier is down, or holds a session we never stored', async () => {
      const { orderId, paymentId } = await kashierPayment();
      gateway.startOutage();
      await expect(directory.createKashierSession(orderId, window())).rejects.toMatchObject({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        httpStatus: 502,
      });
      gateway.endOutage();
      // Kashier created a session but our call never saw the answer.
      await gateway.createSession({
        merchantOrderId: paymentId,
        amount: '150.00',
        currency: 'EGP',
        expiresAt: new Date(Date.now() + 60_000),
        customerReference: orderId,
        description: 'lost',
      });
      await expect(directory.createKashierSession(orderId, window())).rejects.toMatchObject({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      });
      expect(
        t.logs.entries().some((e) => e.event === 'KASHIER_SESSION_LOST' && e.paymentId === paymentId),
      ).toBe(true);
    });
  });

  describe('provider status, markPaidFromProvider and expire (PA-13)', () => {
    it('maps the session status, and reports unknown when Kashier is down', async () => {
      const { orderId } = await kashierPayment();
      expect(await directory.fetchProviderStatus(orderId)).toBe('unpaid'); // no session yet
      await directory.createKashierSession(orderId, {
        expiresAt: new Date(Date.now() + 60_000),
        description: 'x',
      });
      const sessionId = (
        await knex()('payments')
          .where({ order_id: orderId })
          .first<{ provider_order_ref: string }>('provider_order_ref')
      ).provider_order_ref;
      expect(await directory.fetchProviderStatus(orderId)).toBe('unpaid');
      gateway.setStatus(sessionId, 'pending');
      expect(await directory.fetchProviderStatus(orderId)).toBe('pending');
      gateway.startOutage();
      expect(await directory.fetchProviderStatus(orderId)).toBe('unknown');
      gateway.endOutage();
      gateway.setStatus(sessionId, 'paid');
      expect(await directory.fetchProviderStatus(orderId)).toBe('paid');

      expect(await directory.markPaidFromProvider(orderId)).toBe('paid');
      expect(await directory.markPaidFromProvider(orderId)).toBe('already_settled');
    });

    it('expire is conditional on initiated and publishes payment.expired', async () => {
      const { orderId, paymentId } = await kashierPayment();
      expect(await t.infra.db.run((trx) => directory.expire(orderId, trx))).toBe(true);
      expect(await t.infra.db.run((trx) => directory.expire(orderId, trx))).toBe(false);
      expect((await paymentRow(paymentId))?.status).toBe('expired');
      expect(await outboxOf('payment.expired', paymentId)).toHaveLength(1);
    });
  });

  describe('POST /webhooks/kashier (UC-PA-1, UC-PA-2)', () => {
    it('a signed success marks the payment paid once; a redelivery is a no-op', async () => {
      const { orderId, paymentId } = await kashierPayment();
      const data = { merchantOrderId: paymentId, transactionId: `TX-${randomUUID()}` };
      const res = await postWebhook(data);
      expect(res.status).toBe(200);
      expect(successBody<{ received: boolean }>(res).data).toEqual({ received: true });
      expect(await paymentRow(paymentId)).toMatchObject({
        status: 'paid',
        collected_amount: '150.00',
        provider_transaction_ref: data.transactionId,
      });
      expect((await outboxOf('payment.paid', paymentId)).map((e) => e.payload)).toEqual([
        expect.objectContaining({ orderId, amount: '150.00', lateAfterExpiry: false }),
      ]);
      expect((await postWebhook(data)).status).toBe(200);
      expect(await outboxOf('payment.paid', paymentId)).toHaveLength(1);
      const events = await knex()('payment_events')
        .where({ payment_id: paymentId })
        .select<{ provider_event_id: string; processed_at: Date | null }[]>(
          'provider_event_id',
          'processed_at',
        );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ provider_event_id: `pay:${data.transactionId}` });
      expect(events[0]?.processed_at).not.toBeNull();
    });

    it('a bad or missing signature is 401 and stores nothing; it is not rate limited away', async () => {
      const { paymentId } = await kashierPayment();
      const data = { merchantOrderId: paymentId, transactionId: `TX-${randomUUID()}` };
      for (const options of [{ key: 'another-key' }, { signature: null }, { signature: 'ab'.repeat(32) }]) {
        const res = await postWebhook(data, options);
        expect([res.status, errorBody(res).error.code]).toEqual([401, 'INVALID_WEBHOOK_SIGNATURE']);
      }
      expect(await knex()('payment_events').where({ payment_id: paymentId })).toEqual([]);
      expect((await paymentRow(paymentId))?.status).toBe('initiated');
    });

    it('a failed attempt is recorded only; the payment stays initiated (S-4)', async () => {
      const { paymentId } = await kashierPayment();
      expect(
        (
          await postWebhook({
            merchantOrderId: paymentId,
            transactionId: `TX-${randomUUID()}`,
            status: 'FAILED',
          })
        ).status,
      ).toBe(200);
      expect((await paymentRow(paymentId))?.status).toBe('initiated');
      expect(await knex()('payment_events').where({ payment_id: paymentId })).toHaveLength(1);
    });

    it('an unknown order is recorded without a payment and answered 200', async () => {
      const transactionId = `TX-${randomUUID()}`;
      expect((await postWebhook({ merchantOrderId: randomUUID(), transactionId })).status).toBe(200);
      const row = await knex()('payment_events')
        .where({ provider_event_id: `pay:${transactionId}` })
        .first<{ payment_id: string | null }>('payment_id');
      expect(row).toEqual({ payment_id: null });
      expect(t.logs.entries().some((e) => e.event === 'KASHIER_UNKNOWN_ORDER')).toBe(true);
    });

    it('a different amount fails the payment and flags a refund of what was paid (PA-6)', async () => {
      const { paymentId } = await kashierPayment();
      await postWebhook({ merchantOrderId: paymentId, transactionId: `TX-${randomUUID()}`, amount: 140 });
      expect(await paymentRow(paymentId)).toMatchObject({ status: 'failed', collected_amount: '140.00' });
      expect(
        await knex()('payment_refunds').where({ payment_id: paymentId }).select('amount', 'reason', 'status'),
      ).toEqual([{ amount: '140.00', reason: 'amount_mismatch', status: 'pending_auto' }]);
      expect((await outboxOf('payment.failed', paymentId)).map((e) => e.payload.reason)).toEqual([
        'amount_mismatch',
      ]);
    });

    it('a success after expiry marks it paid late and flags a full refund (SD-5)', async () => {
      const { paymentId } = await kashierPayment('expired');
      await postWebhook({ merchantOrderId: paymentId, transactionId: `TX-${randomUUID()}` });
      expect((await paymentRow(paymentId))?.status).toBe('paid');
      expect(
        await knex()('payment_refunds').where({ payment_id: paymentId }).select('amount', 'reason'),
      ).toEqual([{ amount: '150.00', reason: 'late_payment_after_expiry' }]);
      expect((await outboxOf('payment.paid', paymentId)).map((e) => e.payload.lateAfterExpiry)).toEqual([
        true,
      ]);
    });
  });

  describe('admin refunds (UC-PA-4, spec 10 §4.2)', () => {
    const as = (token: string) => ({
      get: (path: string) => request(t.app).get(`${API}${path}`).set('Authorization', `Bearer ${token}`),
      record: (refundId: string, body: object, key: string | null = randomUUID()) => {
        const req = request(t.app)
          .post(`${API}/admin/payments/refunds/${refundId}/record`)
          .set('Authorization', `Bearer ${token}`);
        return (key ? req.set('Idempotency-Key', key) : req).send(body);
      },
    });

    /** A paid Kashier payment of 150.00 with two refunds due: 100.00 and 50.00. */
    async function paidWithRefunds() {
      const { orderId, paymentId } = await kashierPayment('paid');
      await knex()('payments')
        .where({ id: paymentId })
        .update({ collected_amount: '150.00', paid_at: new Date() });
      const due = (amount: string, reason: string) =>
        knex()('payment_refunds')
          .insert({
            payment_id: paymentId,
            seller_order_id: null,
            amount,
            reason,
            status: 'pending_manual',
            recorded_by_user_id: null,
            recorded_at: null,
            provider_refund_ref: null,
            method: 'manual',
            attempt_count: 0,
          })
          .returning<{ id: string }[]>('id');
      const [first] = await due('100.00', 'seller_order_cancelled');
      const [second] = await due('50.00', 'all_cancelled_fee');
      if (!first || !second) throw new Error('fixture');
      return { orderId, paymentId, first: first.id, second: second.id };
    }

    it('records refunds: partial, then full; a second record of one is refused', async () => {
      const { orderId, paymentId, first, second } = await paidWithRefunds();
      const partial = await as(adminToken).record(first, { providerRefundRef: 'KR-1' });
      expect(partial.status).toBe(200);
      expect(successBody<RefundDto>(partial).data).toMatchObject({
        status: 'recorded',
        providerRefundRef: 'KR-1',
        recordedByUserId: adminUserId,
        orderId,
      });
      expect(await paymentRow(paymentId)).toMatchObject({
        status: 'partially_refunded',
        refunded_amount: '100.00',
      });
      await as(adminToken).record(second, { providerRefundRef: 'KR-2' });
      expect(await paymentRow(paymentId)).toMatchObject({
        status: 'refunded',
        refunded_amount: '150.00',
      });
      expect(
        (await outboxOf('payment.refund_recorded', paymentId)).map((e) => e.payload.newPaymentStatus),
      ).toEqual(['partially_refunded', 'refunded']);

      const again = await as(adminToken).record(first, { providerRefundRef: 'KR-1' });
      expect([again.status, errorBody(again).error.code]).toEqual([409, 'REFUND_ALREADY_RECORDED']);
      const missing = await as(adminToken).record(UNKNOWN_V7_ID, { providerRefundRef: 'KR-3' });
      expect([missing.status, errorBody(missing).error.code]).toEqual([404, 'REFUND_NOT_FOUND']);
    });

    it('validation, Idempotency-Key and the admin role are required', async () => {
      const { first } = await paidWithRefunds();
      expect((await as(adminToken).record(first, { providerRefundRef: '' })).status).toBe(400);
      expect((await as(adminToken).record(first, { providerRefundRef: 'x'.repeat(101) })).status).toBe(400);
      expect((await as(adminToken).record(first, { providerRefundRef: 'KR', extra: 1 })).status).toBe(400);
      expect((await as(adminToken).record(first, { providerRefundRef: 'KR' }, null)).status).toBe(400);
      const customerToken = await signTestAccessToken({
        sub: (await fx.insertCustomer()).userId,
        role: 'customer',
      });
      expect((await as(customerToken).record(first, { providerRefundRef: 'KR' })).status).toBe(403);
      expect((await as(customerToken).get('/admin/payments/refunds')).status).toBe(403);
    });

    it('the refund queue lists pending refunds oldest first, and the payment views show refunds and events', async () => {
      const { orderId, paymentId, first, second } = await paidWithRefunds();
      const queue = successBody<RefundDto[]>(
        await as(adminToken).get('/admin/payments/refunds?status[eq]=pending_manual&limit=100'),
      ).data;
      const mine = queue.filter((r) => r.paymentId === paymentId).map((r) => r.id);
      expect(mine).toEqual([first, second]);
      const created = queue.map((r) => r.createdAt);
      expect([...created].sort()).toEqual(created);
      expect((await as(adminToken).get('/admin/payments/refunds?reason[in]=all_cancelled_fee')).status).toBe(
        200,
      );
      expect((await as(adminToken).get('/admin/payments/refunds?reason[eq]=goodwill')).status).toBe(400);

      await postWebhook({
        merchantOrderId: paymentId,
        transactionId: `TX-${randomUUID()}`,
        status: 'FAILED',
      });
      const byId = successBody<AdminPaymentDto>(
        await as(adminToken).get(`/admin/payments/${paymentId}`),
      ).data;
      expect(byId).toMatchObject({
        id: paymentId,
        orderId,
        method: 'kashier',
        status: 'paid',
        collectedAmount: '150.00',
      });
      expect(byId.refunds.map((r) => r.id)).toEqual([first, second]);
      expect(byId.events).toEqual([expect.objectContaining({ eventType: 'pay', signatureValid: true })]);
      expect(JSON.stringify(byId.events)).not.toContain('payload');
      expect(
        successBody<AdminPaymentDto>(await as(adminToken).get(`/admin/orders/${orderId}/payment`)).data.id,
      ).toBe(paymentId);
      const missing = await as(adminToken).get(`/admin/payments/${UNKNOWN_V7_ID}`);
      expect([missing.status, errorBody(missing).error.code]).toEqual([404, 'PAYMENT_NOT_FOUND']);
    });
  });
});
