import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHIPMENT_UPDATES_QUEUE } from '../../src/app/ordering/constants';
import { type CheckoutResultDto } from '../../src/app/ordering/dto/order-response.dto';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { EventConsumerHost } from '../../src/lib/events';
import { deadLetterQueueName } from '../../src/pkg/messaging';
import { AmqpProbe, waitFor } from '../helpers/amqp-probe';
import { createMemoryLogger, type MemoryLogWriter } from '../helpers/memory-logger';
import { CAIRO_FEE, orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/*
 * Spec 09 UC-OR-6 / UC-OR-8 on real Postgres + RabbitMQ: shipment events (published here, as delivery
 * will from Phase 6) → ordering.shipment-updates → seller order, stock, fee share, close.
 */
describe('ordering: shipment-updates consumer', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let worker: WorkerInfrastructure;
  let workerLogs: MemoryLogWriter;
  let probe: AmqpProbe;
  const agentId = randomUUID();

  const knex = () => t.infra.db.knex;
  const statusOf = async (sellerOrderId: string) =>
    (await knex()('seller_orders').where({ id: sellerOrderId }).first<{ status: string }>('status'))?.status;
  const orderRow = (orderId: string) =>
    knex()('orders')
      .where({ id: orderId })
      .first<{ status: string; delivery_fee: string; total: string; completed_at: Date | null }>(
        'status',
        'delivery_fee',
        'total',
        'completed_at',
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
          aggregateType: 'shipment',
          aggregateId: randomUUID(),
          payload: { shipmentId: randomUUID(), agentId, ...payload },
        }),
      ),
      { persistent: true },
    );
    return eventId;
  };
  const processed = async (eventId: string) =>
    (await knex()('processed_events').where({ consumer: SHIPMENT_UPDATES_QUEUE, event_id: eventId }))
      .length === 1;
  /** Publishes and waits until the consumer committed it. */
  const deliver = async (eventType: string, payload: Record<string, unknown>) => {
    const eventId = publish(eventType, payload);
    await waitFor(() => processed(eventId));
  };

  /** One order with `prices.length` sellers, one unit each; returns the seller orders in seller order. */
  async function order(prices: string[]) {
    const buyer = await api.customer();
    const variants = [];
    for (const price of prices) variants.push(await api.listedVariant({ price }));
    const itemsTotal = prices.reduce((sum, p) => sum + Number(p), 0);
    const result: CheckoutResultDto = await api.placeOrder(
      buyer,
      variants.map((v) => ({ variantId: v.variantId, quantity: 1 })),
      (itemsTotal + Number(CAIRO_FEE)).toFixed(2),
    );
    const sellerOrders = variants.map((v) => ({
      ...v,
      sellerOrder: must(result.order.sellerOrders.find((s) => s.sellerId === v.sellerId)),
    }));
    return { buyer, result, orderId: result.order.id, sellerOrders };
  }

  /** Seller accepts and marks ready over HTTP: the state a shipment starts from. */
  async function ready(entry: { sellerToken: string; sellerOrder: { id: string } }) {
    const seller = api.as(entry.sellerToken);
    expect((await seller.post(`/seller/orders/${entry.sellerOrder.id}/accept`)).status).toBe(200);
    expect((await seller.post(`/seller/orders/${entry.sellerOrder.id}/ready`)).status).toBe(200);
  }

  /** picked up → out for delivery → delivered, with the COD amounts the agent collected. */
  async function deliverParcel(
    orderId: string,
    sellerOrderId: string,
    cod: { collected: string; fee: string },
  ) {
    const ids = { orderId, sellerOrderId };
    await deliver('shipment.picked_up', { ...ids, pickedUpAt: new Date().toISOString() });
    await deliver('shipment.out_for_delivery', { ...ids, attemptNumber: 1 });
    await deliver('shipment.delivered', {
      ...ids,
      codCollectedAmount: cod.collected,
      deliveryFeeCollected: cod.fee !== '0.00',
      deliveryFeeAmount: cod.fee,
      deliveredAt: new Date().toISOString(),
    });
  }

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
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

  it('picked up → out → delivered: commits the stock, publishes seller_order.delivered, then the close step', async () => {
    const { orderId, sellerOrders } = await order(['100.00', '40.00']);
    const [a, b] = [must(sellerOrders[0]), must(sellerOrders[1])];
    await ready(a);

    await deliver('shipment.picked_up', {
      orderId,
      sellerOrderId: a.sellerOrder.id,
      pickedUpAt: new Date().toISOString(),
    });
    expect(await statusOf(a.sellerOrder.id)).toBe('picked_up');
    await deliver('shipment.out_for_delivery', {
      orderId,
      sellerOrderId: a.sellerOrder.id,
      attemptNumber: 1,
    });
    expect(await statusOf(a.sellerOrder.id)).toBe('out_for_delivery');
    const deliveredAt = new Date().toISOString();
    await deliver('shipment.delivered', {
      orderId,
      sellerOrderId: a.sellerOrder.id,
      codCollectedAmount: '150.00',
      deliveryFeeCollected: true,
      deliveryFeeAmount: CAIRO_FEE,
      deliveredAt,
    });

    expect(await statusOf(a.sellerOrder.id)).toBe('delivered');
    expect(await api.stockOf(a.variantId)).toEqual({ on_hand: 9, reserved: 0 });
    expect(await api.eventsOf('seller_order.delivered', a.sellerOrder.id)).toEqual([
      {
        sellerOrderId: a.sellerOrder.id,
        orderId,
        sellerId: a.sellerId,
        paymentMethod: 'cod',
        subtotal: '100.00',
        commissionRate: '0.1000',
        commission: '10.00',
        sellerNet: '90.00',
        // Without a coupon (spec 02 §6.5): the R1 amounts, and zero coupon fields.
        discountAmount: '0.00',
        discountFunding: null,
        platformDiscount: '0.00',
        agentId,
        // round(50.00 × 0.7) = 35.00 over 2 seller orders; the other one is still open.
        agentFeeShare: '17.50',
        codCollectedAmount: '150.00',
        deliveryFeeCollected: true,
        deliveryFeeAmount: CAIRO_FEE,
        deliveredAt,
      },
    ]);
    expect((await orderRow(orderId))?.status).toBe('in_progress');
    expect(await api.eventsOf('order.closed', orderId)).toEqual([]);

    // The other seller cancels: every seller order is terminal, one delivered → partially completed.
    expect((await api.as(b.sellerToken).post(`/seller/orders/${b.sellerOrder.id}/cancel`)).status).toBe(200);
    expect(await orderRow(orderId)).toMatchObject({
      status: 'partially_completed',
      delivery_fee: CAIRO_FEE,
      total: '150.00',
    });
    expect(await api.eventsOf('order.closed', orderId)).toEqual([
      expect.objectContaining({
        finalStatus: 'partially_completed',
        deliveredItemsTotal: '100.00',
        deliveryFee: CAIRO_FEE,
        originalDeliveryFee: CAIRO_FEE,
      }),
    ]);
  });

  it('the delivery that closes the order also gets the leftover piastres of the fee share (S-13)', async () => {
    // 35.00 over 3 seller orders = 11.66 each + 0.02 left over.
    const { buyer, orderId, sellerOrders } = await order(['10.00', '20.00', '30.00']);
    const [first, second, third] = [must(sellerOrders[0]), must(sellerOrders[1]), must(sellerOrders[2])];
    await ready(first);
    await deliverParcel(orderId, first.sellerOrder.id, { collected: '60.00', fee: CAIRO_FEE });
    expect(must((await api.eventsOf('seller_order.delivered', first.sellerOrder.id))[0]).agentFeeShare).toBe(
      '11.66',
    );

    expect(
      (await api.as(buyer.token).post(`/orders/${orderId}/seller-orders/${second.sellerOrder.id}/cancel`))
        .status,
    ).toBe(200);
    await ready(third);
    await deliverParcel(orderId, third.sellerOrder.id, { collected: '30.00', fee: '0.00' });
    expect(must((await api.eventsOf('seller_order.delivered', third.sellerOrder.id))[0]).agentFeeShare).toBe(
      '11.68',
    );
    const closed = await orderRow(orderId);
    expect(closed).toMatchObject({ status: 'partially_completed', total: '90.00' });
    expect(closed?.completed_at).not.toBeNull();
  });

  it('a failed attempt, a retry, then a return to the seller; nothing delivered closes the order without a fee', async () => {
    const { orderId, sellerOrders } = await order(['70.00']);
    const only = must(sellerOrders[0]);
    const ids = { orderId, sellerOrderId: only.sellerOrder.id };
    await ready(only);
    await deliver('shipment.picked_up', { ...ids, pickedUpAt: new Date().toISOString() });
    await deliver('shipment.out_for_delivery', { ...ids, attemptNumber: 1 });
    await deliver('shipment.attempt_failed', {
      ...ids,
      attemptNumber: 1,
      reason: 'customer_unreachable',
      returningToSeller: false,
    });
    expect(await statusOf(only.sellerOrder.id)).toBe('delivery_failed');
    await deliver('shipment.out_for_delivery', { ...ids, attemptNumber: 2 });
    await deliver('shipment.attempt_failed', {
      ...ids,
      attemptNumber: 2,
      reason: 'customer_refused',
      returningToSeller: true,
    });
    expect(await statusOf(only.sellerOrder.id)).toBe('returning_to_seller');
    expect(await api.stockOf(only.variantId)).toEqual({ on_hand: 10, reserved: 1 });

    expect(
      (await api.as(only.sellerToken).post(`/seller/orders/${only.sellerOrder.id}/return-received`)).status,
    ).toBe(200);
    expect(await api.stockOf(only.variantId)).toEqual({ on_hand: 10, reserved: 0 });
    expect(await orderRow(orderId)).toMatchObject({
      status: 'cancelled',
      delivery_fee: '0.00',
      total: '0.00',
    });
    expect(await api.eventsOf('order.closed', orderId)).toEqual([
      expect.objectContaining({ finalStatus: 'cancelled', deliveredItemsTotal: '0.00', deliveryFee: '0.00' }),
    ]);
  });

  it('an event for a cancelled seller order is ignored with a warning', async () => {
    const { orderId, sellerOrders } = await order(['25.00']);
    const only = must(sellerOrders[0]);
    await ready(only);
    expect((await api.as(only.sellerToken).post(`/seller/orders/${only.sellerOrder.id}/cancel`)).status).toBe(
      200,
    );
    await deliver('shipment.picked_up', {
      orderId,
      sellerOrderId: only.sellerOrder.id,
      pickedUpAt: new Date().toISOString(),
    });
    expect(await statusOf(only.sellerOrder.id)).toBe('cancelled');
    expect(
      workerLogs
        .entries()
        .some((e) => e.event === 'SHIPMENT_EVENT_IGNORED' && e.sellerOrderId === only.sellerOrder.id),
    ).toBe(true);
  });

  it('an event that overtook its predecessor is retried until the predecessor is applied (OR-14)', async () => {
    const { orderId, sellerOrders } = await order(['15.00']);
    const only = must(sellerOrders[0]);
    await ready(only);
    const ids = { orderId, sellerOrderId: only.sellerOrder.id };
    const early = publish('shipment.out_for_delivery', { ...ids, attemptNumber: 1 });
    const predecessor = publish('shipment.picked_up', { ...ids, pickedUpAt: new Date().toISOString() });
    await waitFor(async () => (await processed(early)) && (await processed(predecessor)));
    expect(await statusOf(only.sellerOrder.id)).toBe('out_for_delivery');
  });

  it('a malformed payload, an unknown seller order or a COD delivery without the cash amount goes to the DLQ', async () => {
    const dlq = deadLetterQueueName(SHIPMENT_UPDATES_QUEUE);
    const before = await probe.messageCount(dlq);
    publish('shipment.picked_up', {
      orderId: 'nope',
      sellerOrderId: randomUUID(),
      pickedUpAt: new Date().toISOString(),
    });
    publish('shipment.out_for_delivery', {
      orderId: randomUUID(),
      sellerOrderId: randomUUID(),
      attemptNumber: 1,
    });

    const { orderId, sellerOrders } = await order(['35.00']);
    const only = must(sellerOrders[0]);
    await ready(only);
    await deliver('shipment.picked_up', {
      orderId,
      sellerOrderId: only.sellerOrder.id,
      pickedUpAt: new Date().toISOString(),
    });
    await deliver('shipment.out_for_delivery', {
      orderId,
      sellerOrderId: only.sellerOrder.id,
      attemptNumber: 1,
    });
    publish('shipment.delivered', {
      orderId,
      sellerOrderId: only.sellerOrder.id,
      codCollectedAmount: null,
      deliveryFeeCollected: false,
      deliveryFeeAmount: '0.00',
      deliveredAt: new Date().toISOString(),
    });
    await waitFor(async () => (await probe.messageCount(dlq)) === before + 3);
    // Rolled back with the failed attempt: the parcel is still out.
    expect(await statusOf(only.sellerOrder.id)).toBe('out_for_delivery');
  });
});
