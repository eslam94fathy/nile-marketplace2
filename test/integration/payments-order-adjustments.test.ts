import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORDER_ADJUSTMENTS_QUEUE } from '../../src/app/payments/constants';
import { type IPaymentDirectory } from '../../src/app/payments';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { TOKENS } from '../../src/lib/di';
import { EventConsumerHost } from '../../src/lib/events';
import { Money } from '../../src/lib/money';
import { deadLetterQueueName } from '../../src/pkg/messaging';
import { AmqpProbe, waitFor } from '../helpers/amqp-probe';
import { createMemoryLogger, type MemoryLogWriter } from '../helpers/memory-logger';
import { orderFixtures } from '../helpers/order-fixtures';
import { startTestApp, type TestApp } from '../helpers/test-app';

/*
 * Spec 10 UC-PA-3 on real Postgres + RabbitMQ: ordering's events (published here, as ordering will)
 * → payments.order-adjustments → payment amounts, statuses and refund rows.
 */
describe('payments: order-adjustments consumer', () => {
  let t: TestApp;
  let worker: WorkerInfrastructure;
  let workerLogs: MemoryLogWriter;
  let probe: AmqpProbe;
  let fx: ReturnType<typeof orderFixtures>;
  let directory: IPaymentDirectory;

  const knex = () => t.infra.db.knex;
  const paymentOf = (orderId: string) =>
    knex()('payments')
      .where({ order_id: orderId })
      .first<{ status: string; amount: string; collected_amount: string }>(
        'status',
        'amount',
        'collected_amount',
      );
  const refundsOf = (paymentId: string) =>
    knex()('payment_refunds')
      .where({ payment_id: paymentId })
      .orderBy('id')
      .select<{ seller_order_id: string | null; amount: string; reason: string; status: string }[]>(
        'seller_order_id',
        'amount',
        'reason',
        'status',
      );

  const publish = (eventType: string, payload: Record<string, unknown>, eventId = randomUUID()): string => {
    probe.channel.publish(
      worker.env.RABBITMQ_EXCHANGE,
      eventType,
      Buffer.from(
        JSON.stringify({
          eventId,
          eventType,
          version: 1,
          occurredAt: new Date().toISOString(),
          correlationId: null,
          aggregateType: eventType.split('.')[0],
          aggregateId: randomUUID(),
          payload,
        }),
      ),
      { persistent: true },
    );
    return eventId;
  };
  /** Publishes and waits until the consumer committed it (processed_events, architecture §3.2). */
  const deliver = async (eventType: string, payload: Record<string, unknown>, eventId = randomUUID()) => {
    publish(eventType, payload, eventId);
    await waitFor(
      async () =>
        (await knex()('processed_events').where({ consumer: ORDER_ADJUSTMENTS_QUEUE, event_id: eventId }))
          .length === 1,
    );
  };

  /** A COD order of 300.00 (2 × 125.00 items + 50.00 fee) with its payment created through the public API. */
  async function codOrder() {
    const chain = await fx.insertOrderChain();
    await knex()('orders').where({ id: chain.orderId }).update({ items_total: '250.00', total: '300.00' });
    const paymentId = await t.infra.db.run((trx) =>
      directory.createForOrder(
        { orderId: chain.orderId, customerId: chain.customerId, method: 'cod', amount: Money.of('300.00') },
        trx,
      ),
    );
    return { ...chain, paymentId };
  }

  /** A Kashier order of 150.00 whose payment is `status`. */
  async function kashierOrder(status: 'paid' | 'initiated') {
    const { customerId } = await fx.insertCustomer();
    const { sellerId, productId, variantId } = await fx.insertVariantChain();
    const orderId = await fx.insertOrder(customerId, {
      payment_method: 'kashier',
      status: status === 'paid' ? 'placed' : 'pending_payment',
      payment_expires_at: new Date(),
    });
    const sellerOrderId = await fx.insertSellerOrder(orderId, sellerId);
    await fx.insertOrderItem(sellerOrderId, { variantId, productId });
    const paymentId = await fx.insertPayment(orderId, {
      method: 'kashier',
      status,
      collected_amount: status === 'paid' ? '150.00' : '0.00',
      paid_at: status === 'paid' ? new Date() : null,
    });
    return { orderId, sellerOrderId, sellerId, paymentId };
  }

  beforeAll(async () => {
    t = await startTestApp();
    fx = orderFixtures(knex());
    directory = t.container.resolve<IPaymentDirectory>(TOKENS.PaymentDirectory);
    const { logger, writer } = createMemoryLogger();
    workerLogs = writer;
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    const container = createWorkerContainer(worker);
    await worker.broker.assertExchange(worker.env.RABBITMQ_EXCHANGE);
    const consumers = new EventConsumerHost(worker.broker, worker.db, logger, worker.env);
    for (const handler of createEventHandlers(container)) await consumers.start(handler);
    probe = await AmqpProbe.open(t.resources.workerEnv.RABBITMQ_URL);
  });
  afterAll(async () => {
    await probe.close();
    await closeInfrastructure(worker);
    await t.close();
  });

  it('createForOrder starts COD at pending and Kashier at initiated; getSummaries is batched', async () => {
    const cod = await codOrder();
    const { customerId } = await fx.insertCustomer();
    const kashierOrderId = await fx.insertOrder(customerId, {
      payment_method: 'kashier',
      status: 'pending_payment',
      payment_expires_at: new Date(),
      placed_at: null,
    });
    await t.infra.db.run((trx) =>
      directory.createForOrder(
        { orderId: kashierOrderId, customerId, method: 'kashier', amount: Money.of('150.00') },
        trx,
      ),
    );
    const summaries = await directory.getSummaries([cod.orderId, kashierOrderId, randomUUID()]);
    expect(summaries.sort((a, b) => a.method.localeCompare(b.method))).toEqual([
      {
        orderId: cod.orderId,
        method: 'cod',
        status: 'pending',
        amount: '300.00',
        collectedAmount: '0.00',
        refundedAmount: '0.00',
      },
      {
        orderId: kashierOrderId,
        method: 'kashier',
        status: 'initiated',
        amount: '150.00',
        collectedAmount: '0.00',
        refundedAmount: '0.00',
      },
    ]);
  });

  it('COD: cancellations lower the amount, deliveries add up, and the close settles on what was collected', async () => {
    const order = await codOrder();
    const base = {
      orderId: order.orderId,
      sellerOrderId: order.sellerOrderId,
      sellerId: order.sellerId,
      paymentMethod: 'cod',
    };
    await deliver('seller_order.items_cancelled', {
      ...base,
      amountCancelled: '125.00',
      lines: [],
      reason: 'out_of_stock',
    });
    expect(await paymentOf(order.orderId)).toEqual({
      status: 'pending',
      amount: '175.00',
      collected_amount: '0.00',
    });

    await deliver('seller_order.delivered', {
      ...base,
      codCollectedAmount: '175.00',
      deliveryFeeCollected: true,
    });
    expect(await paymentOf(order.orderId)).toEqual({
      status: 'partially_collected',
      amount: '175.00',
      collected_amount: '175.00',
    });

    await deliver('order.closed', {
      orderId: order.orderId,
      paymentMethod: 'cod',
      deliveredItemsTotal: '125.00',
      deliveryFee: '50.00',
      originalDeliveryFee: '50.00',
    });
    expect(await paymentOf(order.orderId)).toEqual({
      status: 'collected',
      amount: '175.00',
      collected_amount: '175.00',
    });
    expect(workerLogs.entries().some((e) => e.event === 'COD_SETTLED' && e.orderId === order.orderId)).toBe(
      true,
    );
  });

  it('COD: nothing delivered → cancelled at 0.00; a fee never collected is flagged', async () => {
    const cancelled = await codOrder();
    await deliver('seller_order.cancelled', {
      orderId: cancelled.orderId,
      sellerOrderId: cancelled.sellerOrderId,
      amountCancelled: '250.00',
    });
    await deliver('order.closed', {
      orderId: cancelled.orderId,
      deliveredItemsTotal: '0.00',
      deliveryFee: '0.00',
      originalDeliveryFee: '50.00',
    });
    expect(await paymentOf(cancelled.orderId)).toEqual({
      status: 'cancelled',
      amount: '0.00',
      collected_amount: '0.00',
    });

    const feeless = await codOrder();
    await deliver('seller_order.delivered', {
      orderId: feeless.orderId,
      sellerOrderId: feeless.sellerOrderId,
      codCollectedAmount: '250.00',
    });
    await deliver('order.closed', {
      orderId: feeless.orderId,
      deliveredItemsTotal: '250.00',
      deliveryFee: '50.00',
      originalDeliveryFee: '50.00',
    });
    expect(await paymentOf(feeless.orderId)).toEqual({
      status: 'collected',
      amount: '250.00',
      collected_amount: '250.00',
    });
    expect(
      workerLogs
        .entries()
        .some((e) => e.event === 'COD_DELIVERY_FEE_UNCOLLECTED' && e.orderId === feeless.orderId),
    ).toBe(true);
  });

  it('Kashier (paid): cancellations and returns become refunds due; a close with no delivery refunds the fee', async () => {
    const order = await kashierOrder('paid');
    const base = { orderId: order.orderId, sellerOrderId: order.sellerOrderId };
    await deliver('seller_order.items_cancelled', { ...base, amountCancelled: '50.00' });
    await deliver('seller_order.returned', { ...base, subtotal: '50.00' });
    await deliver('seller_order.delivered', { ...base, codCollectedAmount: null });
    await deliver('order.closed', {
      orderId: order.orderId,
      deliveredItemsTotal: '0.00',
      deliveryFee: '0.00',
      originalDeliveryFee: '50.00',
    });

    expect(await refundsOf(order.paymentId)).toEqual([
      {
        seller_order_id: order.sellerOrderId,
        amount: '50.00',
        reason: 'items_cancelled',
        status: 'pending_manual',
      },
      {
        seller_order_id: order.sellerOrderId,
        amount: '50.00',
        reason: 'delivery_failed',
        status: 'pending_manual',
      },
      { seller_order_id: null, amount: '50.00', reason: 'all_cancelled_fee', status: 'pending_manual' },
    ]);
    expect(await paymentOf(order.orderId)).toEqual({
      status: 'paid',
      amount: '150.00',
      collected_amount: '150.00',
    });
  });

  it('Kashier (never paid): order events change nothing', async () => {
    const order = await kashierOrder('initiated');
    await deliver('seller_order.cancelled', {
      orderId: order.orderId,
      sellerOrderId: order.sellerOrderId,
      amountCancelled: '100.00',
    });
    await deliver('order.closed', {
      orderId: order.orderId,
      deliveredItemsTotal: '0.00',
      deliveryFee: '0.00',
      originalDeliveryFee: '50.00',
    });
    expect(await refundsOf(order.paymentId)).toEqual([]);
    expect(await paymentOf(order.orderId)).toEqual({
      status: 'initiated',
      amount: '150.00',
      collected_amount: '0.00',
    });
  });

  it('a redelivered event is applied once', async () => {
    const order = await kashierOrder('paid');
    const eventId = randomUUID();
    const payload = { orderId: order.orderId, sellerOrderId: order.sellerOrderId, amountCancelled: '100.00' };
    await deliver('seller_order.cancelled', payload, eventId);
    publish('seller_order.cancelled', payload, eventId);
    // A later event on the same queue proves the duplicate was consumed before it.
    await deliver('seller_order.returned', { ...payload, subtotal: '1.00' });
    expect((await refundsOf(order.paymentId)).map((r) => r.reason)).toEqual([
      'seller_order_cancelled',
      'delivery_failed',
    ]);
  });

  it('a malformed payload or an order without a payment goes to the DLQ', async () => {
    const dlq = deadLetterQueueName(ORDER_ADJUSTMENTS_QUEUE);
    const before = await probe.messageCount(dlq);
    publish('seller_order.cancelled', {
      orderId: randomUUID(),
      sellerOrderId: randomUUID(),
      amountCancelled: '-1',
    });
    publish('order.closed', {
      orderId: randomUUID(),
      deliveredItemsTotal: '0.00',
      deliveryFee: '0.00',
      originalDeliveryFee: '0.00',
    });
    await waitFor(async () => (await probe.messageCount(dlq)) === before + 2);
  });
});
