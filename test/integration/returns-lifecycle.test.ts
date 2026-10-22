import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ReturnJobs } from '../../src/app/returns/service/return-jobs.job';
import { TOKENS } from '../../src/lib/di';
import { type ISecretBox } from '../../src/pkg/crypto';
import { type Agent, type DeliveryFlow, startDeliveryFlow } from '../helpers/delivery-flow';
import { successBody } from '../helpers/http';
import { signTestAccessToken } from '../helpers/jwt';
import { insertReadyMedia } from '../helpers/media';
import { CAIRO_FEE } from '../helpers/ordering-api';

interface ReturnBody {
  id: string;
  status: string;
  refundAmount: string;
  refusalReason: string | null;
  items: { id: string; orderItemId: string; quantity: number; restock: boolean | null }[];
  photos: { id: string }[];
}

const wallet = { method: 'mobile_wallet', walletNumber: '+201001234567' };

/*
 * Spec 18 end to end on real Postgres + RabbitMQ: a delivered COD order is returned through the return
 * shipment (spec 11 §8), completed, disputed, failed at pickup, and moved on by the jobs (UC-RE-9).
 */
describe('return lifecycle', () => {
  let flow: DeliveryFlow;
  let agent: Agent;
  let admin: ReturnType<DeliveryFlow['api']['as']>;
  const knex = () => flow.knex();

  /** A COD order of `quantity` × 100.00 from one seller, delivered by `agent`. */
  async function deliveredOrder(quantity = 1) {
    const { api, readyAndAssigned, act, settle, sellerOrderStatus } = flow;
    const buyer = await api.customer();
    const variant = await api.listedVariant({ price: '100.00' });
    const { order } = await api.placeOrder(
      buyer,
      [{ variantId: variant.variantId, quantity }],
      (100 * quantity + Number(CAIRO_FEE)).toFixed(2),
    );
    const sellerOrderId = order.sellerOrders[0]?.id ?? '';
    const orderItemId = order.sellerOrders[0]?.items[0]?.id ?? '';
    const shipmentId = await readyAndAssigned({ sellerToken: variant.sellerToken, sellerOrderId }, agent);
    await act(agent, shipmentId, 'picked-up');
    const out = await act(agent, shipmentId, 'out-for-delivery');
    await act(agent, shipmentId, 'delivered', { codCollectedAmount: out.amountToCollect });
    await settle(async () => (await sellerOrderStatus(sellerOrderId)) === 'delivered');
    return {
      buyer: api.as(buyer.token),
      buyerUserId: buyer.userId,
      seller: api.as(variant.sellerToken),
      sellerUserId: variant.sellerUserId,
      variantId: variant.variantId,
      orderId: order.id,
      sellerOrderId,
      orderItemId,
    };
  }
  type Delivered = Awaited<ReturnType<typeof deliveredOrder>>;

  async function requested(d: Delivered, body: Record<string, unknown> = {}): Promise<ReturnBody> {
    const res = await d.buyer.post(
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
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return successBody<ReturnBody>(res).data;
  }

  const statusOf = async (returnId: string) =>
    (await knex()('return_requests').where({ id: returnId }).first<{ status: string }>('status'))?.status;
  const returnShipment = (returnId: string) =>
    knex()('shipments')
      .where({ return_id: returnId })
      .first<{ id: string; status: string; agent_id: string | null; kind: string } | undefined>(
        'id',
        'status',
        'agent_id',
        'kind',
      );

  /** Approved by the seller, its return shipment created and assigned to `agent`. */
  async function approvedAndAssigned(d: Delivered, returnId: string): Promise<string> {
    expect((await d.seller.post(`/seller/returns/${returnId}/approve`)).status).toBe(200);
    let shipmentId = '';
    await flow.settle(async () => {
      const shipment = await returnShipment(returnId);
      shipmentId = shipment?.id ?? '';
      return shipment?.agent_id === agent.agentId;
    });
    return shipmentId;
  }

  /** Picked up and handed to the seller: the return is `received`. */
  async function received(d: Delivered, returnId: string): Promise<void> {
    const shipmentId = await approvedAndAssigned(d, returnId);
    await flow.act(agent, shipmentId, 'picked-up');
    await flow.settle(async () => (await statusOf(returnId)) === 'picked_up');
    await flow.act(agent, shipmentId, 'delivered');
    await flow.settle(async () => (await statusOf(returnId)) === 'received');
  }

  beforeAll(async () => {
    flow = await startDeliveryFlow();
    agent = await flow.soleAgent();
    const adminId = await flow.fx.insertUser('admin');
    admin = flow.api.as(await signTestAccessToken({ sub: adminId, role: 'admin' }));
  }, 120_000);
  afterAll(async () => {
    await flow.close();
  });

  it('returns through the return shipment, restocks and completes with the final amounts', async () => {
    const d = await deliveredOrder(2);
    const stockBefore = await flow.api.stockOf(d.variantId);
    const created = await requested(d);
    expect(created.refundAmount).toBe('50.00');
    const shipmentId = await approvedAndAssigned(d, created.id);
    expect((await returnShipment(created.id))?.kind).toBe('return');

    // A return shipment never goes out for delivery.
    flow.refused(
      await agent.http.post(`/agent/shipments/${shipmentId}/out-for-delivery`),
      409,
      'SHIPMENT_INVALID_STATUS_TRANSITION',
    );
    const view = successBody<{ kind: string; returnId: string; amountToCollect: string }>(
      await agent.http.get(`/agent/shipments/${shipmentId}`),
    ).data;
    expect(view).toMatchObject({ kind: 'return', returnId: created.id, amountToCollect: '0.00' });

    // RE-24: once the agent has the parcel, the cancel is refused even before returns hears of it.
    await flow.act(agent, shipmentId, 'picked-up');
    flow.refused(
      await d.buyer.post(`/returns/${created.id}/cancel`),
      409,
      'RETURN_INVALID_STATUS_TRANSITION',
    );
    await flow.settle(async () => (await statusOf(created.id)) === 'picked_up');
    await flow.act(agent, shipmentId, 'delivered');
    await flow.settle(async () => (await statusOf(created.id)) === 'received');

    const [item] = created.items;
    flow.refused(
      await d.seller.post(`/seller/returns/${created.id}/confirm-receipt`, { items: [] }, randomUUID()),
      400,
      'VALIDATION_FAILED',
    );
    flow.refused(
      await d.seller.post(
        `/seller/returns/${created.id}/confirm-receipt`,
        { items: [{ returnItemId: '0192f5e0-0000-7000-8000-000000000000', restock: true }] },
        randomUUID(),
      ),
      422,
      'RETURN_ITEMS_MISMATCH',
    );
    const res = await d.seller.post(
      `/seller/returns/${created.id}/confirm-receipt`,
      { items: [{ returnItemId: item?.id, restock: true }] },
      randomUUID(),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(successBody<ReturnBody>(res).data).toMatchObject({
      status: 'completed',
      refundAmount: '50.00',
      items: [expect.objectContaining({ restock: true })],
    });

    expect((await flow.api.stockOf(d.variantId)).on_hand).toBe((stockBefore?.on_hand ?? 0) + 1);
    const sellerOrder = await knex()('seller_orders')
      .where({ id: d.sellerOrderId })
      .first<Record<string, string>>('status', 'returned_subtotal', 'returned_paid', 'returned_commission');
    expect(sellerOrder).toMatchObject({
      status: 'delivered',
      returned_subtotal: '100.00',
      returned_paid: '100.00',
    });
    const [completed] = await flow.api.eventsOf('return.completed', created.id);
    expect(completed).toMatchObject({
      returnId: created.id,
      paymentMethod: 'cod',
      itemsPaid: '100.00',
      returnFee: CAIRO_FEE,
      returnFeePayer: 'customer',
      agentId: agent.agentId,
      agentFeeShare: '35.00',
      refundAmount: '50.00',
    });
    const box = flow.t.container.resolve<ISecretBox>(TOKENS.SecretBox);
    expect(
      JSON.parse(box.open(String(completed?.refundPayoutEncrypted), `${created.id}:refund_payout`)),
    ).toEqual(wallet);
    const [row] = await knex()('return_requests')
      .where({ id: created.id })
      .select<{ refund_payout_encrypted: string | null }[]>('refund_payout_encrypted');
    expect(row).toEqual({ refund_payout_encrypted: null });
  });

  it('a refused pickup cancels the return shipment and ends the return', async () => {
    const d = await deliveredOrder();
    const created = await requested(d);
    const shipmentId = await approvedAndAssigned(d, created.id);
    const failed = await flow.act(agent, shipmentId, 'failed-attempt', { reason: 'customer_refused' });
    expect(failed.status).toBe('cancelled');
    await flow.settle(async () => (await statusOf(created.id)) === 'pickup_failed');
    const [row] = await knex()('return_requests')
      .where({ id: created.id })
      .select<{ refund_payout_encrypted: string | null }[]>('refund_payout_encrypted');
    expect(row).toEqual({ refund_payout_encrypted: null });
  });

  it('a cancel before pickup cancels the return shipment through delivery.return-updates', async () => {
    const d = await deliveredOrder();
    const created = await requested(d);
    await approvedAndAssigned(d, created.id);
    expect((await d.buyer.post(`/returns/${created.id}/cancel`)).status).toBe(200);
    await flow.settle(async () => (await returnShipment(created.id))?.status === 'cancelled');
  });

  it('disputes: the admin upholds one, refunds the next without restocking', async () => {
    const d = await deliveredOrder(2);
    const stockBefore = await flow.api.stockOf(d.variantId);
    const first = await requested(d);
    await received(d, first.id);
    const photo = await insertReadyMedia(flow.t, d.sellerUserId, 'return_photo');
    const disputed = await d.seller.post(`/seller/returns/${first.id}/dispute`, {
      reason: 'The item came back used',
      photoMediaIds: [photo],
    });
    expect(successBody<ReturnBody>(disputed).data).toMatchObject({
      status: 'disputed',
      photos: [{ id: photo }],
    });
    const upheld = await admin.post(
      `/admin/returns/${first.id}/resolve-dispute`,
      { decision: 'no_refund', note: 'Photos show wear' },
      randomUUID(),
    );
    expect(successBody<ReturnBody>(upheld).data).toMatchObject({
      status: 'refused',
      refusalReason: 'dispute_upheld',
    });
    const [audit] = await knex()('admin_audit_log')
      .where({ action: 'return.dispute_resolved', target_id: first.id })
      .select<{ changes: unknown }[]>('changes');
    expect(audit?.changes).toEqual({
      before: { status: 'disputed' },
      after: { status: 'refused', decision: 'no_refund' },
    });

    const second = await requested(d);
    await received(d, second.id);
    await d.seller.post(`/seller/returns/${second.id}/dispute`, { reason: 'Not the item we sent' });
    const refunded = await admin.post(
      `/admin/returns/${second.id}/resolve-dispute`,
      { decision: 'refund', note: 'Benefit of the doubt' },
      randomUUID(),
    );
    expect(successBody<ReturnBody>(refunded).data).toMatchObject({
      status: 'completed',
      items: [expect.objectContaining({ restock: false })],
    });
    expect((await flow.api.stockOf(d.variantId))?.on_hand).toBe(stockBefore?.on_hand);
    expect(await flow.api.eventsOf('return.completed', second.id)).toHaveLength(1);
  });

  it('a dispute after the inspection deadline is refused (RE-25)', async () => {
    const d = await deliveredOrder();
    const created = await requested(d);
    await received(d, created.id);
    await knex()('return_requests')
      .where({ id: created.id })
      .update({ inspection_deadline_at: new Date(Date.now() - 1000) });
    flow.refused(
      await d.seller.post(`/seller/returns/${created.id}/dispute`, { reason: 'Too late' }),
      409,
      'RETURN_INSPECTION_WINDOW_CLOSED',
    );
  });

  it('the jobs approve silence, refuse a lapsed rejection and complete an uninspected return', async () => {
    const jobs = flow.workerContainer.resolve<ReturnJobs>(TOKENS.ReturnJobs);
    const past = new Date(Date.now() - 1000);

    const silent = await requested(await deliveredOrder());
    await knex()('return_requests').where({ id: silent.id }).update({ seller_decision_deadline_at: past });

    const rejectedOrder = await deliveredOrder();
    const rejected = await requested(rejectedOrder);
    await rejectedOrder.seller.post(`/seller/returns/${rejected.id}/reject`, { reason: 'Used item' });
    await knex()('return_requests').where({ id: rejected.id }).update({ escalation_deadline_at: past });

    const uninspectedOrder = await deliveredOrder();
    const uninspected = await requested(uninspectedOrder);
    await received(uninspectedOrder, uninspected.id);
    const stockBefore = await flow.api.stockOf(uninspectedOrder.variantId);
    await knex()('return_requests').where({ id: uninspected.id }).update({ inspection_deadline_at: past });

    expect(await jobs.run()).toBeGreaterThanOrEqual(3);
    expect(await statusOf(silent.id)).toBe('approved');
    expect(await flow.api.eventsOf('return.approved', silent.id)).toHaveLength(1);
    expect(
      await knex()('return_requests').where({ id: rejected.id }).first('status', 'refusal_reason'),
    ).toEqual({ status: 'refused', refusal_reason: 'seller_rejected' });
    expect(await statusOf(uninspected.id)).toBe('completed');
    expect((await flow.api.stockOf(uninspectedOrder.variantId))?.on_hand).toBe(stockBefore?.on_hand);
    const history = await knex()('return_status_history')
      .where({ return_id: uninspected.id, to_status: 'completed' })
      .select('actor_role');
    expect(history).toEqual([{ actor_role: 'system' }]);
    expect(await jobs.run()).toBe(0);
  });
});
