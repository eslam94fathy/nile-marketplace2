import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentShipmentDto } from '../../src/app/delivery/dto/shipment.dto';
import { type DeliveryFlow, startDeliveryFlow } from '../helpers/delivery-flow';
import { successBody } from '../helpers/http';
import { signTestAccessToken } from '../helpers/jwt';
import { CAIRO_FEE } from '../helpers/ordering-api';

const UNKNOWN_V7_ID = '0192f5e0-0000-7000-8000-000000000000';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/* Spec 11 UC-DE-3 and DE-6, end to end with ordering's and payments' consumers (plan §8.4). */
describe('delivery: the agent works its shipments', () => {
  let flow: DeliveryFlow;

  let api: DeliveryFlow['api'];
  let fx: DeliveryFlow['fx'];
  let settle: DeliveryFlow['settle'];
  let sellerOrderStatus: DeliveryFlow['sellerOrderStatus'];
  let soleAgent: DeliveryFlow['soleAgent'];
  let order: DeliveryFlow['order'];
  let readyAndAssigned: DeliveryFlow['readyAndAssigned'];
  let act: DeliveryFlow['act'];
  let refused: DeliveryFlow['refused'];

  const knex = () => flow.knex();
  const shipmentRow = (id: string) =>
    knex()('shipments').where({ id }).first<{
      status: string;
      carries_delivery_fee: boolean;
      cod_fee_amount: string;
      attempt_count: number;
    }>('status', 'carries_delivery_fee', 'cod_fee_amount', 'attempt_count');

  /** A shipment of a fresh SQL order, already with `agent` in `status`. */
  async function ownShipment(agent: { agentId: string }, overrides: Record<string, unknown> = {}) {
    return fx.insertShipmentChain({
      agent_id: agent.agentId,
      status: 'picked_up',
      assigned_at: new Date(),
      picked_up_at: new Date(),
      ...overrides,
    });
  }

  beforeAll(async () => {
    flow = await startDeliveryFlow();
    ({ api, fx, settle, sellerOrderStatus, soleAgent, order, readyAndAssigned, act, refused } = flow);
  });
  afterAll(async () => {
    await flow.close();
  });

  it('COD end to end: the first parcel out carries the fee; both delivered → order completed, payment collected', async () => {
    const agent = await soleAgent();
    const { orderId, sellerOrders } = await order(['100.00', '40.00']);
    const [a, b] = [must(sellerOrders[0]), must(sellerOrders[1])];
    const first = await readyAndAssigned(a, agent);

    const listed = successBody<AgentShipmentDto[]>(await agent.http.get('/agent/shipments')).data;
    expect(listed.map((s) => [s.id, s.status])).toEqual([[first, 'assigned']]);

    expect((await act(agent, first, 'picked-up')).pickedUpAt).not.toBeNull();
    await settle(async () => (await sellerOrderStatus(a.sellerOrderId)) === 'picked_up');
    const out = await act(agent, first, 'out-for-delivery');
    expect(out).toMatchObject({
      status: 'out_for_delivery',
      codFeeAmount: CAIRO_FEE,
      amountToCollect: '150.00',
    });
    await settle(async () => (await sellerOrderStatus(a.sellerOrderId)) === 'out_for_delivery');

    const delivered = (body?: object) => agent.http.post(`/agent/shipments/${first}/delivered`, body);
    refused(await delivered(), 422, 'COD_AMOUNT_REQUIRED');
    refused(await delivered({ codCollectedAmount: '100.00' }), 422, 'COD_AMOUNT_MISMATCH');
    expect((await delivered({ codCollectedAmount: 150 })).status).toBe(400);
    expect(
      (await act(agent, first, 'delivered', { codCollectedAmount: '150.00' })).deliveredAt,
    ).not.toBeNull();
    expect(await api.eventsOf('shipment.delivered', first)).toEqual([
      expect.objectContaining({
        orderId,
        sellerOrderId: a.sellerOrderId,
        agentId: agent.agentId,
        codCollectedAmount: '150.00',
        deliveryFeeCollected: true,
        deliveryFeeAmount: CAIRO_FEE,
      }),
    ]);
    await settle(async () => (await sellerOrderStatus(a.sellerOrderId)) === 'delivered');

    // The second parcel goes out after the fee was collected: items only.
    const second = await readyAndAssigned(b, agent);
    await act(agent, second, 'picked-up');
    expect((await act(agent, second, 'out-for-delivery')).amountToCollect).toBe('40.00');
    await act(agent, second, 'delivered', { codCollectedAmount: '40.00' });
    expect(must((await api.eventsOf('shipment.delivered', second))[0])).toMatchObject({
      deliveryFeeCollected: false,
      deliveryFeeAmount: '0.00',
      codCollectedAmount: '40.00',
    });
    await settle(async () => {
      const row = await knex()('orders').where({ id: orderId }).first<{ status: string }>('status');
      const payment = await knex()('payments')
        .where({ order_id: orderId })
        .first<{ status: string }>('status');
      return row?.status === 'completed' && payment?.status === 'collected';
    });
    expect(successBody<AgentShipmentDto[]>(await agent.http.get('/agent/shipments')).data).toEqual([]);
    const history = successBody<AgentShipmentDto[]>(
      await agent.http.get('/agent/shipments?status[in]=delivered'),
    );
    expect(history.data.map((s) => s.id)).toEqual([first, second]);
  });

  it('a failure releases the fee to the next parcel going out; a refusal sends the parcel back', async () => {
    const agent = await soleAgent();
    const { sellerOrders } = await order(['100.00', '40.00']);
    const [a, b] = [must(sellerOrders[0]), must(sellerOrders[1])];
    const first = await readyAndAssigned(a, agent);
    const second = await readyAndAssigned(b, agent);
    await act(agent, first, 'picked-up');
    await act(agent, second, 'picked-up');
    expect((await act(agent, first, 'out-for-delivery')).amountToCollect).toBe('150.00');

    const failed = await act(agent, first, 'failed-attempt', {
      reason: 'customer_unreachable',
      note: 'No answer',
    });
    expect(failed).toMatchObject({ status: 'delivery_failed', attemptCount: 1, amountToCollect: '100.00' });
    expect(failed.attempts).toEqual([
      expect.objectContaining({ attemptNumber: 1, reason: 'customer_unreachable', note: 'No answer' }),
    ]);
    expect(await api.eventsOf('shipment.attempt_failed', first)).toEqual([
      expect.objectContaining({ attemptNumber: 1, reason: 'customer_unreachable', returningToSeller: false }),
    ]);
    await settle(async () => (await sellerOrderStatus(a.sellerOrderId)) === 'delivery_failed');

    expect((await act(agent, second, 'out-for-delivery')).amountToCollect).toBe('90.00');
    const again = await act(agent, first, 'out-for-delivery');
    expect(again).toMatchObject({ amountToCollect: '100.00', codFeeAmount: '0.00' });
    expect(must((await api.eventsOf('shipment.out_for_delivery', first))[1])).toMatchObject({
      attemptNumber: 2,
    });

    const back = await act(agent, first, 'failed-attempt', { reason: 'customer_refused' });
    expect(back).toMatchObject({ status: 'returning_to_seller', attemptCount: 2 });
    await settle(async () => (await sellerOrderStatus(a.sellerOrderId)) === 'returning_to_seller');
    refused(
      await agent.http.post(`/agent/shipments/${first}/out-for-delivery`),
      409,
      'SHIPMENT_INVALID_STATUS_TRANSITION',
    );
    // Not cancelled after pickup: the seller confirms this return (step 6), not the agent.
    refused(
      await agent.http.post(`/agent/shipments/${first}/returned`),
      409,
      'SHIPMENT_INVALID_STATUS_TRANSITION',
    );
  });

  it('the 3rd failed attempt sends the parcel back', async () => {
    const agent = await soleAgent();
    const { shipmentId } = await ownShipment(agent);
    for (const n of [1, 2]) {
      await act(agent, shipmentId, 'out-for-delivery');
      expect(await act(agent, shipmentId, 'failed-attempt', { reason: 'wrong_address' })).toMatchObject({
        status: 'delivery_failed',
        attemptCount: n,
      });
    }
    await act(agent, shipmentId, 'out-for-delivery');
    expect(await act(agent, shipmentId, 'failed-attempt', { reason: 'customer_rescheduled' })).toMatchObject({
      status: 'returning_to_seller',
      attemptCount: 3,
    });
    expect(await shipmentRow(shipmentId)).toMatchObject({
      carries_delivery_fee: false,
      cod_fee_amount: '0.00',
    });
  });

  it('a prepaid (Kashier) parcel collects nothing and takes no amount', async () => {
    const agent = await soleAgent();
    const { shipmentId } = await ownShipment(agent, {
      payment_method: 'kashier',
      order_delivery_fee: '0.00',
      cod_items_amount: '0.00',
    });
    expect(await act(agent, shipmentId, 'out-for-delivery')).toMatchObject({
      amountToCollect: '0.00',
      codFeeAmount: '0.00',
    });
    refused(
      await agent.http.post(`/agent/shipments/${shipmentId}/delivered`, { codCollectedAmount: '0.00' }),
      422,
      'COD_AMOUNT_NOT_ALLOWED',
    );
    expect((await act(agent, shipmentId, 'delivered')).status).toBe('delivered');
    expect(must((await api.eventsOf('shipment.delivered', shipmentId))[0])).toMatchObject({
      codCollectedAmount: null,
      deliveryFeeCollected: false,
    });
  });

  it('two parcels of one checkout going out at once: exactly one carries the fee', async () => {
    const one = await soleAgent();
    const otherAgent = await fx.insertAgent({ on_shift: true });
    const other = {
      ...otherAgent,
      http: api.as(await signTestAccessToken({ sub: otherAgent.userId, role: 'delivery_agent' })),
    };
    const { orderId, shipmentId: first } = await ownShipment(one);
    const { sellerId } = await fx.insertSeller();
    const sellerOrderId = await fx.insertSellerOrder(orderId, sellerId);
    const second = await fx.insertShipment(
      { sellerOrderId, orderId },
      { agent_id: other.agentId, status: 'picked_up', assigned_at: new Date(), picked_up_at: new Date() },
    );
    const [r1, r2] = await Promise.all([
      one.http.post(`/agent/shipments/${first}/out-for-delivery`),
      other.http.post(`/agent/shipments/${second}/out-for-delivery`),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const rows = await knex()('shipments')
      .where({ order_id: orderId })
      .select<{ carries_delivery_fee: boolean }[]>('carries_delivery_fee');
    expect(rows.filter((r) => r.carries_delivery_fee)).toHaveLength(1);
  });

  it('the agent confirms the return of a parcel whose seller order was cancelled after pickup (DE-6)', async () => {
    const agent = await soleAgent();
    const { shipmentId } = await ownShipment(agent, {
      status: 'returning_to_seller',
      seller_order_cancelled_at: new Date(),
    });
    refused(
      await agent.http.post(`/agent/shipments/${shipmentId}/returned`, undefined, null),
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    expect((await act(agent, shipmentId, 'returned')).status).toBe('returned_to_seller');
    const row = await knex()('shipments')
      .where({ id: shipmentId })
      .first<{ returned_at: Date | null }>('returned_at');
    expect(row?.returned_at).not.toBeNull();
    refused(
      await agent.http.post(`/agent/shipments/${shipmentId}/returned`),
      409,
      'SHIPMENT_INVALID_STATUS_TRANSITION',
    );
  });

  it("another agent's or an unknown shipment is not found; bad input, other roles and inactive agents are refused", async () => {
    const agent = await soleAgent();
    const stranger = await fx.insertAgent();
    const { shipmentId } = await ownShipment(stranger);
    const paths = ['', '/picked-up', '/out-for-delivery', '/delivered', '/failed-attempt', '/returned'];
    for (const path of paths) {
      const res = path
        ? await agent.http.post(
            `/agent/shipments/${shipmentId}${path}`,
            path === '/failed-attempt' ? { reason: 'wrong_address' } : undefined,
          )
        : await agent.http.get(`/agent/shipments/${shipmentId}`);
      refused(res, 404, 'SHIPMENT_NOT_FOUND');
    }
    refused(await agent.http.get(`/agent/shipments/${UNKNOWN_V7_ID}`), 404, 'SHIPMENT_NOT_FOUND');
    expect((await agent.http.get('/agent/shipments/not-a-uuid')).status).toBe(400);

    const { shipmentId: mine } = await ownShipment(agent, { status: 'out_for_delivery' });
    const fail = (body: object) => agent.http.post(`/agent/shipments/${mine}/failed-attempt`, body);
    expect((await fail({ reason: 'lost' })).status).toBe(400);
    expect((await fail({})).status).toBe(400);
    expect((await fail({ reason: 'wrong_address', note: 'x'.repeat(501) })).status).toBe(400);
    expect((await fail({ reason: 'wrong_address', extra: true })).status).toBe(400);
    expect((await agent.http.get('/agent/shipments?status[eq]=lost')).status).toBe(400);
    refused(
      await agent.http.post(`/agent/shipments/${mine}/picked-up`),
      409,
      'SHIPMENT_INVALID_STATUS_TRANSITION',
    );

    const customer = await api.customer();
    expect((await api.as(customer.token).get('/agent/shipments')).status).toBe(403);
    expect((await api.as(undefined).get('/agent/shipments')).status).toBe(401);
    await knex()('delivery_agents')
      .where({ id: agent.agentId })
      .update({ status: 'inactive', on_shift: false });
    refused(await agent.http.get('/agent/shipments'), 403, 'AGENT_INACTIVE');
    refused(await agent.http.post(`/agent/shipments/${mine}/delivered`), 403, 'AGENT_INACTIVE');
  });

  it('lists the active shipments oldest first, in pages', async () => {
    const agent = await soleAgent();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1)
      ids.push((await ownShipment(agent, { status: 'assigned', picked_up_at: null })).shipmentId);
    await ownShipment(agent, { status: 'delivered', delivered_at: new Date() });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: AgentShipmentDto[]; meta?: { nextCursor?: string | null } } = successBody<
        AgentShipmentDto[]
      >(await agent.http.get(`/agent/shipments?limit=3${cursor ? `&cursor=${cursor}` : ''}`));
      seen.push(...page.data.map((s) => s.id));
      cursor = page.meta?.nextCursor ?? null;
    } while (cursor);
    expect(seen).toEqual(ids);
  });
});
