import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrderingJobs } from '../../src/app/ordering';
import { PAYMENT_UPDATES_QUEUE } from '../../src/app/ordering/constants';
import { type CheckoutResultDto, type SellerOrderDto } from '../../src/app/ordering/dto/order-response.dto';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { EventConsumerHost, OutboxDrainer } from '../../src/lib/events';
import { type JobDefinition } from '../../src/lib/jobs';
import { type FakePaymentGateway, signKashierWebhook } from '../../src/pkg/payments';
import { waitFor } from '../helpers/amqp-probe';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { createMemoryLogger } from '../helpers/memory-logger';
import { CAIRO_FEE, orderingApi } from '../helpers/ordering-api';
import { TEST_KASHIER_API_KEY } from '../helpers/test-env';
import { startTestApp, type TestApp } from '../helpers/test-app';

const SIGNATURE_KEYS = ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId'];

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/*
 * Spec 09 §3.1 (Kashier), §3.10 (expiry), §3.11 (payment results) and §4.1.2 end to end: checkout →
 * Kashier session (fake gateway, PA-5) → signed webhook → outbox → ordering.payment-updates, and the
 * kashier-payment-expiry job. The worker shares the api's fake gateway, as one Kashier would be.
 */
describe('ordering: Kashier checkout, payment and expiry', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let gateway: FakePaymentGateway;
  let worker: WorkerInfrastructure;
  let drainer: OutboxDrainer;
  let expiryJob: JobDefinition;

  const knex = () => t.infra.db.knex;
  const orderRow = (id: string) =>
    knex()('orders')
      .where({ id })
      .first<{ status: string; placed_at: Date | null; total: string; delivery_fee: string }>(
        'status',
        'placed_at',
        'total',
        'delivery_fee',
      );
  const sellerOrdersOf = (orderId: string) =>
    knex()('seller_orders')
      .where({ order_id: orderId })
      .select<{ status: string; cancel_reason: string | null; accept_deadline_at: Date | null }[]>(
        'status',
        'cancel_reason',
        'accept_deadline_at',
      );
  const paymentOf = (orderId: string) =>
    knex()('payments')
      .where({ order_id: orderId })
      .first<{ id: string; status: string; provider_order_ref: string | null }>(
        'id',
        'status',
        'provider_order_ref',
      );
  const processed = async (orderId: string, eventType: string) => {
    const row = await knex()('events_outbox')
      .where({ event_type: eventType })
      .whereRaw(`payload->>'orderId' = ?`, [orderId])
      .first<{ id: string } | undefined>('id');
    if (!row) return false;
    return (
      (await knex()('processed_events').where({ consumer: PAYMENT_UPDATES_QUEUE, event_id: row.id }))
        .length === 1
    );
  };

  /** A customer with one 100.00 line, checked out with Kashier (total 150.00). */
  async function kashierOrder() {
    const buyer = await api.customer();
    const variant = await api.listedVariant({ price: '100.00' });
    await api.fillCart(buyer.customerId, [{ variantId: variant.variantId, quantity: 1 }]);
    const res = await api
      .as(buyer.token)
      .checkout({ addressId: buyer.addressId, paymentMethod: 'kashier', expectedTotal: '150.00' });
    expect(res.status).toBe(201);
    return { buyer, variant, result: successBody<CheckoutResultDto>(res).data };
  }

  function webhook(paymentId: string, overrides: Record<string, unknown> = {}) {
    const data = {
      signatureKeys: SIGNATURE_KEYS,
      merchantOrderId: paymentId,
      transactionId: `TX-${randomUUID()}`,
      status: 'SUCCESS',
      amount: 150,
      currency: 'EGP',
      ...overrides,
    };
    return request(t.app)
      .post(`${API}/webhooks/kashier`)
      .set('Content-Type', 'application/json')
      .set('x-kashier-signature', signKashierWebhook(data, SIGNATURE_KEYS, TEST_KASHIER_API_KEY))
      .send(JSON.stringify({ event: 'pay', data }));
  }

  /** Publishes the outbox and waits until ordering.payment-updates committed `eventType` for the order. */
  async function deliverPaymentEvent(orderId: string, eventType: string) {
    await drainer.drainOnce();
    await waitFor(() => processed(orderId, eventType));
  }

  const expireWindow = (orderId: string) =>
    knex()('orders')
      .where({ id: orderId })
      .update({ payment_expires_at: new Date(Date.now() - 1_000) });

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
    gateway = t.infra.paymentGateway as FakePaymentGateway;
    const { logger } = createMemoryLogger();
    worker = {
      ...(await createWorkerInfrastructure(t.resources.workerEnv, logger)),
      paymentGateway: t.infra.paymentGateway,
    };
    const container = createWorkerContainer(worker);
    await worker.broker.assertExchange(worker.env.RABBITMQ_EXCHANGE);
    const consumers = new EventConsumerHost(worker.broker, worker.db, logger, worker.env);
    for (const handler of createEventHandlers(container)) await consumers.start(handler);
    drainer = new OutboxDrainer(worker.db.knex, worker.broker, worker.clock, logger, {
      exchange: worker.env.RABBITMQ_EXCHANGE,
      batchSize: worker.env.OUTBOX_BATCH_SIZE,
      maxBackoffMs: worker.env.OUTBOX_MAX_BACKOFF_MS,
    });
    expiryJob = must(
      createOrderingJobs(container, worker.env).find((job) => job.name === 'kashier-payment-expiry'),
    );
  });
  afterAll(async () => {
    await closeInfrastructure(worker);
    await t.close();
  });

  it('a Kashier checkout awaits payment: no deadline, stock held, payment page, hidden from sellers', async () => {
    const { variant, result } = await kashierOrder();
    const { order, kashier } = result;
    expect(order).toMatchObject({
      status: 'pending_payment',
      paymentMethod: 'kashier',
      paymentStatus: 'initiated',
    });
    expect(order.sellerOrders.map((s) => [s.status, s.canCancel])).toEqual([['pending_payment', false]]);
    const minutesLeft = (new Date(must(order.paymentExpiresAt ?? undefined)).getTime() - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(14.9);
    expect(minutesLeft).toBeLessThanOrEqual(15);
    expect(kashier?.checkoutUrl).toMatch(/^https:\/\/fake-kashier\.invalid\/session\//);
    expect(kashier?.expiresAt).toBe(order.paymentExpiresAt);
    expect((await sellerOrdersOf(order.id))[0]?.accept_deadline_at).toBeNull();
    expect(await api.stockOf(variant.variantId)).toEqual({ on_hand: 10, reserved: 1 });
    expect((await paymentOf(order.id))?.provider_order_ref).not.toBeNull();
    expect(await api.eventsOf('order.placed', order.id)).toEqual([]);
    expect(
      successBody<SellerOrderDto[]>(await api.as(variant.sellerToken).get('/seller/orders')).data,
    ).toEqual([]);
  });

  it('when Kashier fails at checkout the order still commits; kashier-session hands out the page later', async () => {
    gateway.startOutage();
    const { buyer, result } = await kashierOrder();
    expect(result.kashier?.checkoutUrl).toBeNull();
    const session = (orderId: string, token = buyer.token) =>
      api.as(token).post(`/orders/${orderId}/payment/kashier-session`, undefined, null);
    const down = await session(result.order.id);
    expect([down.status, errorBody(down).error.code]).toEqual([502, 'PAYMENT_PROVIDER_UNAVAILABLE']);
    gateway.endOutage();

    const first = await session(result.order.id);
    expect(first.status).toBe(200);
    const page = successBody<{ checkoutUrl: string; expiresAt: string }>(first).data;
    expect(page.expiresAt).toBe(result.order.paymentExpiresAt);
    expect(successBody<{ checkoutUrl: string }>(await session(result.order.id)).data.checkoutUrl).toBe(
      page.checkoutUrl,
    );

    const stranger = await api.customer();
    expect((await session(result.order.id, stranger.token)).status).toBe(404);
    const cod = await api.placeOrder(
      buyer,
      [{ variantId: (await api.listedVariant()).variantId, quantity: 1 }],
      '150.00',
    );
    const notKashier = await session(cod.order.id);
    expect([notKashier.status, errorBody(notKashier).error.code]).toEqual([
      409,
      'ORDER_NOT_AWAITING_PAYMENT',
    ]);
  });

  // OR-16 (security review F-2): one unpaid Kashier order per customer, so stock can't be hoarded.
  it('a second Kashier checkout waits for the open payment; COD still goes through; paying frees it', async () => {
    const { buyer, result } = await kashierOrder();
    const fillCart = async () => {
      const variant = await api.listedVariant({ price: '100.00' });
      await api.fillCart(buyer.customerId, [{ variantId: variant.variantId, quantity: 1 }]);
    };
    const checkout = (paymentMethod: 'kashier' | 'cod') =>
      api.as(buyer.token).checkout({ addressId: buyer.addressId, paymentMethod, expectedTotal: '150.00' });

    await fillCart();
    const second = await checkout('kashier');
    expect([second.status, errorBody(second).error.code]).toEqual([409, 'ORDER_PAYMENT_PENDING']);
    expect(errorBody(second).error.details?.[0]).toMatchObject({ field: 'orderId', value: result.order.id });
    // Nothing was placed: the cart still holds the line, and COD can check it out.
    expect((await knex()('orders').where({ customer_id: buyer.customerId })).length).toBe(1);
    expect((await checkout('cod')).status).toBe(201);

    const payment = must(await paymentOf(result.order.id));
    expect((await webhook(payment.id)).status).toBe(200);
    await deliverPaymentEvent(result.order.id, 'payment.paid');
    await fillCart();
    expect((await checkout('kashier')).status).toBe(201);
  });

  it('a paid webhook places the order through payment.paid: seller orders placed with a deadline, order.placed', async () => {
    const { buyer, variant, result } = await kashierOrder();
    const payment = must(await paymentOf(result.order.id));
    expect((await webhook(payment.id)).status).toBe(200);
    await deliverPaymentEvent(result.order.id, 'payment.paid');

    const order = await orderRow(result.order.id);
    expect(order?.status).toBe('placed');
    expect(order?.placed_at).not.toBeNull();
    const [sellerOrder] = await sellerOrdersOf(result.order.id);
    expect(sellerOrder?.status).toBe('placed');
    const hours = (must(sellerOrder?.accept_deadline_at ?? undefined).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(await api.eventsOf('order.placed', result.order.id)).toEqual([
      expect.objectContaining({ orderId: result.order.id, paymentMethod: 'kashier', total: '150.00' }),
    ]);
    expect(
      successBody<SellerOrderDto[]>(await api.as(variant.sellerToken).get('/seller/orders')).data,
    ).toHaveLength(1);
    // Placed: no payment page any more.
    const again = await api
      .as(buyer.token)
      .post(`/orders/${result.order.id}/payment/kashier-session`, undefined, null);
    expect([again.status, errorBody(again).error.code]).toEqual([409, 'ORDER_NOT_AWAITING_PAYMENT']);
  });

  it('expiry: an unpaid order is cancelled, its stock released, the payment expired and the order closed without a fee', async () => {
    const { variant, result } = await kashierOrder();
    await expireWindow(result.order.id);
    expect(await expiryJob.run()).toBeGreaterThanOrEqual(1);

    expect(await orderRow(result.order.id)).toMatchObject({
      status: 'cancelled',
      total: '0.00',
      delivery_fee: '0.00',
    });
    expect(await sellerOrdersOf(result.order.id)).toEqual([
      expect.objectContaining({ status: 'cancelled', cancel_reason: 'payment_expired' }),
    ]);
    expect(await api.stockOf(variant.variantId)).toEqual({ on_hand: 10, reserved: 0 });
    expect((await paymentOf(result.order.id))?.status).toBe('expired');
    expect(await api.eventsOf('order.closed', result.order.id)).toEqual([
      expect.objectContaining({
        finalStatus: 'cancelled',
        deliveryFee: '0.00',
        originalDeliveryFee: CAIRO_FEE,
      }),
    ]);

    // A success that arrives after expiry: paid, refund flagged, the order stays cancelled (SD-5).
    const payment = must(await paymentOf(result.order.id));
    expect((await webhook(payment.id)).status).toBe(200);
    await deliverPaymentEvent(result.order.id, 'payment.paid');
    expect((await paymentOf(result.order.id))?.status).toBe('paid');
    expect((await orderRow(result.order.id))?.status).toBe('cancelled');
    expect(await knex()('payment_refunds').where({ payment_id: payment.id }).select('reason')).toEqual([
      { reason: 'late_payment_after_expiry' },
    ]);
  });

  it('expiry asks Kashier first: a paid session is applied, a payment in flight waits', async () => {
    const paid = await kashierOrder();
    const pending = await kashierOrder();
    for (const order of [paid, pending]) await expireWindow(order.result.order.id);
    const sessionOf = async (orderId: string) =>
      must((await paymentOf(orderId))?.provider_order_ref ?? undefined);
    gateway.setStatus(await sessionOf(paid.result.order.id), 'paid');
    gateway.setStatus(await sessionOf(pending.result.order.id), 'pending');

    await expiryJob.run();
    expect((await paymentOf(paid.result.order.id))?.status).toBe('paid');
    await deliverPaymentEvent(paid.result.order.id, 'payment.paid');
    expect((await orderRow(paid.result.order.id))?.status).toBe('placed');
    expect((await orderRow(pending.result.order.id))?.status).toBe('pending_payment');
    expect((await paymentOf(pending.result.order.id))?.status).toBe('initiated');

    // Once Kashier says it is over, the next run expires it.
    gateway.setStatus(await sessionOf(pending.result.order.id), 'unpaid');
    await expiryJob.run();
    expect((await orderRow(pending.result.order.id))?.status).toBe('cancelled');
  });

  it('expiry while Kashier is unreachable still expires the order (SD-5)', async () => {
    const { result } = await kashierOrder();
    await expireWindow(result.order.id);
    gateway.startOutage();
    try {
      await expiryJob.run();
    } finally {
      gateway.endOutage();
    }
    expect((await orderRow(result.order.id))?.status).toBe('cancelled');
  });

  it('a payment with the wrong amount cancels the order with payment_failed', async () => {
    const { variant, result } = await kashierOrder();
    const payment = must(await paymentOf(result.order.id));
    await webhook(payment.id, { amount: 140 });
    await deliverPaymentEvent(result.order.id, 'payment.failed');
    expect((await orderRow(result.order.id))?.status).toBe('cancelled');
    expect(await sellerOrdersOf(result.order.id)).toEqual([
      expect.objectContaining({ status: 'cancelled', cancel_reason: 'payment_failed' }),
    ]);
    expect(await api.stockOf(variant.variantId)).toEqual({ on_hand: 10, reserved: 0 });
  });

  it('the webhook and the expiry job racing: the order and the payment always agree', async () => {
    const { result } = await kashierOrder();
    const payment = must(await paymentOf(result.order.id));
    await expireWindow(result.order.id);
    await Promise.all([webhook(payment.id), expiryJob.run()]);
    await drainer.drainOnce();
    await waitFor(async () => {
      const [order, current] = await Promise.all([orderRow(result.order.id), paymentOf(result.order.id)]);
      // Either the webhook won (paid → placed by the consumer) or the job did (expired, then a late paid).
      return (order?.status === 'placed' || order?.status === 'cancelled') && current?.status === 'paid';
    });
    const order = await orderRow(result.order.id);
    const refunds = await knex()('payment_refunds').where({ payment_id: payment.id }).select('reason');
    if (order?.status === 'cancelled') expect(refunds).toEqual([{ reason: 'late_payment_after_expiry' }]);
    else expect(refunds).toEqual([]);
  });
});
