import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SELLER_ORDER_UPDATES_QUEUE } from '../../src/app/delivery/constants';
import { type AgentShipmentDto } from '../../src/app/delivery/dto/shipment.dto';
import {
  SellerOrderEventTooEarlyError,
  type SellerOrderUpdateService,
} from '../../src/app/delivery/service/seller-order-update.service';
import { TOKENS } from '../../src/lib/di';
import { type EventEnvelope } from '../../src/lib/events';
import { type DeliveryFlow, startDeliveryFlow } from '../helpers/delivery-flow';
import { successBody } from '../helpers/http';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/* Spec 11 UC-DE-5 with DE-6, DE-10, DE-15, DE-16: cancellations and returns from ordering's events. */
describe('delivery: seller-order updates', () => {
  let flow: DeliveryFlow;

  const knex = () => flow.knex();
  const shipmentOf = (sellerOrderId: string) =>
    knex()('shipments').where({ seller_order_id: sellerOrderId }).first<
      | {
          id: string;
          status: string;
          cod_items_amount: string;
          carries_delivery_fee: boolean;
          seller_order_cancelled_at: Date | null;
          returned_at: Date | null;
        }
      | undefined
    >('id', 'status', 'cod_items_amount', 'carries_delivery_fee', 'seller_order_cancelled_at', 'returned_at');
  const processed = async (eventType: string, aggregateId: string) => {
    const ids = await knex()('events_outbox')
      .where({ event_type: eventType, aggregate_id: aggregateId })
      .pluck<string[]>('id');
    if (ids.length === 0) return false;
    const done = await knex()('processed_events')
      .where({ consumer: SELLER_ORDER_UPDATES_QUEUE })
      .whereIn('event_id', ids);
    return done.length === ids.length;
  };
  const historyOf = (shipmentId: string) =>
    knex()('shipment_status_history')
      .where({ shipment_id: shipmentId })
      .orderBy([{ column: 'created_at' }, { column: 'id' }])
      .select<{ from_status: string | null; to_status: string; actor_role: string; reason: string | null }[]>(
        'from_status',
        'to_status',
        'actor_role',
        'reason',
      );
  const seller = (entry: { sellerToken: string }) => flow.api.as(entry.sellerToken);

  /** The outbox event as the consumer receives it, under a fresh eventId. */
  async function envelopeOf(eventType: string, aggregateId: string): Promise<EventEnvelope> {
    const [row] = await knex()('events_outbox')
      .where({ event_type: eventType, aggregate_id: aggregateId })
      .select<{ payload: Record<string, unknown> }[]>('payload');
    return {
      eventId: randomUUID(),
      eventType,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      aggregateType: 'seller_order',
      aggregateId,
      payload: must(row).payload,
    };
  }
  const consume = (envelope: EventEnvelope) =>
    flow.worker.db.run((trx) =>
      flow.workerContainer
        .resolve<SellerOrderUpdateService>(TOKENS.SellerOrderUpdateService)
        .handle(envelope, trx),
    );

  beforeAll(async () => {
    flow = await startDeliveryFlow();
  });
  afterAll(async () => {
    await flow.close();
  });

  it('cancelled before pickup: the shipment is cancelled and leaves the agent list', async () => {
    const agent = await flow.soleAgent();
    const { sellerOrders } = await flow.order(['100.00']);
    const a = must(sellerOrders[0]);
    const shipmentId = await flow.readyAndAssigned(a, agent);

    expect((await seller(a).post(`/seller/orders/${a.sellerOrderId}/cancel`)).status).toBe(200);
    await flow.settle(async () => (await shipmentOf(a.sellerOrderId))?.status === 'cancelled');
    expect((await historyOf(shipmentId)).at(-1)).toEqual({
      from_status: 'assigned',
      to_status: 'cancelled',
      actor_role: 'system',
      reason: 'seller_cancelled',
    });
    expect(successBody<AgentShipmentDto[]>(await agent.http.get('/agent/shipments')).data).toEqual([]);
    flow.refused(
      await agent.http.post(`/agent/shipments/${shipmentId}/picked-up`),
      409,
      'SHIPMENT_INVALID_STATUS_TRANSITION',
    );
  });

  it('cancelled while the agent already had the parcel: it goes back, the fee is released, the agent confirms the return (DE-6)', async () => {
    const agent = await flow.soleAgent();
    const { sellerOrders } = await flow.order(['100.00']);
    const a = must(sellerOrders[0]);
    const shipmentId = await flow.readyAndAssigned(a, agent);
    // The agent picks up and goes out before ordering hears of it; the seller cancels meanwhile.
    await flow.act(agent, shipmentId, 'picked-up');
    expect((await flow.act(agent, shipmentId, 'out-for-delivery')).amountToCollect).toBe('150.00');
    expect((await seller(a).post(`/seller/orders/${a.sellerOrderId}/cancel`)).status).toBe(200);

    await flow.settle(async () => (await shipmentOf(a.sellerOrderId))?.status === 'returning_to_seller');
    const back = must(await shipmentOf(a.sellerOrderId));
    expect(back.carries_delivery_fee).toBe(false);
    expect(back.seller_order_cancelled_at).not.toBeNull();
    // Ordering ignores the late shipment events of its cancelled seller order.
    await flow.settle(
      async () => (await flow.api.eventsOf('shipment.out_for_delivery', shipmentId)).length === 1,
    );
    expect(await flow.sellerOrderStatus(a.sellerOrderId)).toBe('cancelled');
    expect(
      flow.workerLogs
        .entries()
        .some((l) => l.event === 'SHIPMENT_CANCELLED_AFTER_PICKUP' && l.shipmentId === shipmentId),
    ).toBe(true);

    const listed = successBody<AgentShipmentDto[]>(await agent.http.get('/agent/shipments')).data;
    expect(listed.map((s) => [s.id, s.status, s.amountToCollect])).toEqual([
      [shipmentId, 'returning_to_seller', '100.00'],
    ]);
    expect((await flow.act(agent, shipmentId, 'returned')).status).toBe('returned_to_seller');
    expect(successBody<AgentShipmentDto[]>(await agent.http.get('/agent/shipments')).data).toEqual([]);
  });

  it('a return the seller confirms closes the shipment on both sides', async () => {
    const agent = await flow.soleAgent();
    const { orderId, sellerOrders } = await flow.order(['100.00']);
    const a = must(sellerOrders[0]);
    const shipmentId = await flow.readyAndAssigned(a, agent);
    await flow.act(agent, shipmentId, 'picked-up');
    await flow.act(agent, shipmentId, 'out-for-delivery');
    await flow.act(agent, shipmentId, 'failed-attempt', { reason: 'customer_refused' });
    await flow.settle(async () => (await flow.sellerOrderStatus(a.sellerOrderId)) === 'returning_to_seller');

    const received = await seller(a).post(`/seller/orders/${a.sellerOrderId}/return-received`);
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    await flow.settle(async () => (await shipmentOf(a.sellerOrderId))?.status === 'returned_to_seller');
    expect(must(await shipmentOf(a.sellerOrderId)).returned_at).not.toBeNull();
    expect(await flow.sellerOrderStatus(a.sellerOrderId)).toBe('returned_to_seller');
    expect(await flow.api.stockOf(a.variantId)).toEqual({ on_hand: 10, reserved: 0 });
    const closed = await knex()('orders').where({ id: orderId }).first<{ status: string }>('status');
    expect(closed?.status).not.toBe('in_progress');
    expect(successBody<AgentShipmentDto[]>(await agent.http.get('/agent/shipments')).data).toEqual([]);
  });

  it('items cancelled while ready lower the COD amount; an older event is ignored', async () => {
    const agent = await flow.soleAgent();
    const { sellerOrders } = await flow.order([{ price: '100.00', quantity: 3 }]);
    const a = must(sellerOrders[0]);
    const shipmentId = await flow.readyAndAssigned(a, agent);
    expect(must(await shipmentOf(a.sellerOrderId)).cod_items_amount).toBe('300.00');
    const [item] = await knex()('order_items')
      .where({ seller_order_id: a.sellerOrderId })
      .pluck<string[]>('id');

    const cancelOne = () =>
      seller(a).post(`/seller/orders/${a.sellerOrderId}/items/${must(item)}/cancel`, {
        quantity: 1,
        reason: 'out_of_stock',
      });
    expect((await cancelOne()).status).toBe(200);
    expect((await cancelOne()).status).toBe(200);
    const events = await flow.api.eventsOf('seller_order.items_cancelled', a.sellerOrderId);
    expect(events.map((e) => [e.previousStatus, e.newSubtotal])).toEqual([
      ['ready_for_pickup', '200.00'],
      ['ready_for_pickup', '100.00'],
    ]);
    await flow.settle(() => processed('seller_order.items_cancelled', a.sellerOrderId));
    expect(must(await shipmentOf(a.sellerOrderId)).cod_items_amount).toBe('100.00');

    // The first cancellation again, as if it had overtaken the second: 200.00 is not lower.
    await consume(await envelopeOf('seller_order.items_cancelled', a.sellerOrderId));
    expect(must(await shipmentOf(a.sellerOrderId)).cod_items_amount).toBe('100.00');
    await flow.act(agent, shipmentId, 'picked-up');
    expect((await flow.act(agent, shipmentId, 'out-for-delivery')).amountToCollect).toBe('150.00');
  });

  it('an event that overtakes ready_for_pickup is retried, then applied; one with no shipment coming is acked (DE-10, DE-15)', async () => {
    await flow.soleAgent();
    const { sellerOrders } = await flow.order([{ price: '50.00', quantity: 2 }, '30.00']);
    const [a, b] = [must(sellerOrders[0]), must(sellerOrders[1])];
    await flow.markReady(a);
    const [item] = await knex()('order_items')
      .where({ seller_order_id: a.sellerOrderId })
      .pluck<string[]>('id');
    expect(
      (
        await seller(a).post(`/seller/orders/${a.sellerOrderId}/items/${must(item)}/cancel`, {
          quantity: 1,
          reason: 'seller_request',
        })
      ).status,
    ).toBe(200);
    expect((await seller(a).post(`/seller/orders/${a.sellerOrderId}/cancel`)).status).toBe(200);

    // Nothing published yet: the shipment doesn't exist, but the seller order was ready.
    const itemsCancelled = await envelopeOf('seller_order.items_cancelled', a.sellerOrderId);
    const cancelled = await envelopeOf('seller_order.cancelled', a.sellerOrderId);
    await expect(consume(itemsCancelled)).rejects.toBeInstanceOf(SellerOrderEventTooEarlyError);
    await expect(consume(cancelled)).rejects.toBeInstanceOf(SellerOrderEventTooEarlyError);
    await consume(await envelopeOf('seller_order.ready_for_pickup', a.sellerOrderId));
    expect(must(await shipmentOf(a.sellerOrderId)).cod_items_amount).toBe('100.00');
    await consume(itemsCancelled);
    expect(must(await shipmentOf(a.sellerOrderId)).cod_items_amount).toBe('50.00');
    await consume(cancelled);
    expect(must(await shipmentOf(a.sellerOrderId)).status).toBe('cancelled');

    // Cancelled while accepted: no shipment was ever coming, so the event is simply acked.
    expect((await seller(b).post(`/seller/orders/${b.sellerOrderId}/accept`)).status).toBe(200);
    expect((await seller(b).post(`/seller/orders/${b.sellerOrderId}/cancel`)).status).toBe(200);
    await consume(await envelopeOf('seller_order.cancelled', b.sellerOrderId));
    expect(await shipmentOf(b.sellerOrderId)).toBeUndefined();
  });

  it('seller_order.returned before its shipment exists is retried; on a shipment not coming back it is a no-op', async () => {
    const agent = await flow.soleAgent();
    const { shipmentId, sellerOrderId, orderId } = await flow.fx.insertShipmentChain({
      agent_id: agent.agentId,
      status: 'delivered',
      assigned_at: new Date(),
      picked_up_at: new Date(),
      delivered_at: new Date(),
      cod_collected_amount: '100.00',
    });
    const payload = {
      sellerOrderId,
      orderId,
      sellerId: randomUUID(),
      paymentMethod: 'cod',
      subtotal: '100.00',
      returnedAt: new Date().toISOString(),
    };
    const returned = (forSellerOrder: string): EventEnvelope => ({
      eventId: randomUUID(),
      eventType: 'seller_order.returned',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      aggregateType: 'seller_order',
      aggregateId: forSellerOrder,
      payload: { ...payload, sellerOrderId: forSellerOrder },
    });
    const { sellerOrderId: noShipmentYet } = await flow.fx.insertOrderChain();
    await expect(consume(returned(noShipmentYet))).rejects.toBeInstanceOf(SellerOrderEventTooEarlyError);
    await consume(returned(sellerOrderId));
    const row = await knex()('shipments').where({ id: shipmentId }).first<{ status: string }>('status');
    expect(row?.status).toBe('delivered');
  });
});
