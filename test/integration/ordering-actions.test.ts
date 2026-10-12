import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrderingJobs } from '../../src/app/ordering';
import {
  type CheckoutResultDto,
  type OrderDetailDto,
  type SellerOrderDto,
} from '../../src/app/ordering/dto/order-response.dto';
import { errorBody, successBody } from '../helpers/http';
import { CAIRO_FEE, orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/* Spec 09 UC-OR-2…5, UC-OR-7, the close step (§3.9) and the acceptance timeout (§3.10) over HTTP. */
describe('ordering: cancellations, seller actions and the acceptance timeout', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;

  const knex = () => t.infra.db.knex;
  const orderRow = (orderId: string) =>
    knex()('orders').where({ id: orderId }).first<{
      status: string;
      items_total: string;
      delivery_fee: string;
      total: string;
      cancelled_at: Date | null;
    }>('status', 'items_total', 'delivery_fee', 'total', 'cancelled_at');
  const sellerOrderOf = (result: CheckoutResultDto, sellerId: string) =>
    must(result.order.sellerOrders.find((s) => s.sellerId === sellerId));

  /** One buyer, two sellers: A sells 3 × 100.00, B sells 1 × 40.00 (total 340.00 + fee 50.00). */
  async function twoSellerOrder() {
    const buyer = await api.customer();
    const a = await api.listedVariant({ price: '100.00' });
    const b = await api.listedVariant({ price: '40.00' });
    const result = await api.placeOrder(
      buyer,
      [
        { variantId: a.variantId, quantity: 3 },
        { variantId: b.variantId, quantity: 1 },
      ],
      '390.00',
    );
    return {
      buyer,
      a,
      b,
      result,
      soA: sellerOrderOf(result, a.sellerId),
      soB: sellerOrderOf(result, b.sellerId),
    };
  }

  const timeoutJob = () => {
    const jobs = createOrderingJobs(t.container.createChildContainer(), t.resources.workerEnv);
    return must(jobs.find((job) => job.name === 'seller-acceptance-timeout'));
  };

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
  });
  afterAll(async () => {
    await t.close();
  });

  describe('customer cancels a seller order (UC-OR-2)', () => {
    it('cancels it, releases its stock, lowers the order total, and closes the order when the last one goes', async () => {
      const { buyer, a, b, result, soA, soB } = await twoSellerOrder();
      const cancel = (sellerOrderId: string, body: object = {}) =>
        api.as(buyer.token).post(`/orders/${result.order.id}/seller-orders/${sellerOrderId}/cancel`, body);

      const first = await cancel(soB.id, { note: 'Changed my mind' });
      expect(first.status).toBe(200);
      const afterFirst = successBody<OrderDetailDto>(first).data;
      expect(sellerOrderOf({ order: afterFirst, kashier: null }, b.sellerId)).toMatchObject({
        status: 'cancelled',
        canCancel: false,
      });
      expect(afterFirst).toMatchObject({
        status: 'placed',
        itemsTotal: '300.00',
        deliveryFee: CAIRO_FEE,
        total: '350.00',
      });
      expect(await api.stockOf(b.variantId)).toEqual({ on_hand: 10, reserved: 0 });
      expect(await api.eventsOf('seller_order.cancelled', soB.id)).toEqual([
        expect.objectContaining({
          orderId: result.order.id,
          sellerId: b.sellerId,
          paymentMethod: 'cod',
          previousStatus: 'placed',
          reason: 'customer_cancelled',
          amountCancelled: '40.00',
        }),
      ]);
      const history = await knex()('seller_order_status_history')
        .where({ seller_order_id: soB.id })
        .orderBy('created_at')
        .select('to_status', 'actor_role', 'actor_user_id', 'reason');
      expect(history.at(-1)).toEqual({
        to_status: 'cancelled',
        actor_role: 'customer',
        actor_user_id: buyer.userId,
        reason: 'Changed my mind',
      });

      expect((await cancel(soA.id)).status).toBe(200);
      const closed = await orderRow(result.order.id);
      expect(closed).toMatchObject({
        status: 'cancelled',
        items_total: '0.00',
        delivery_fee: '0.00',
        total: '0.00',
      });
      expect(closed?.cancelled_at).not.toBeNull();
      expect(await api.stockOf(a.variantId)).toEqual({ on_hand: 10, reserved: 0 });
      expect(await api.eventsOf('order.closed', result.order.id)).toEqual([
        expect.objectContaining({
          finalStatus: 'cancelled',
          deliveredItemsTotal: '0.00',
          deliveryFee: '0.00',
          originalDeliveryFee: CAIRO_FEE,
        }),
      ]);
    });

    it('only while placed; another customer gets 404; the seller order must belong to the order', async () => {
      const { buyer, a, result, soA } = await twoSellerOrder();
      const path = (sellerOrderId: string, orderId = result.order.id) =>
        `/orders/${orderId}/seller-orders/${sellerOrderId}/cancel`;
      expect((await api.as(a.sellerToken).post(`/seller/orders/${soA.id}/accept`)).status).toBe(200);
      const late = await api.as(buyer.token).post(path(soA.id));
      expect([late.status, errorBody(late).error.code]).toEqual([409, 'SELLER_ORDER_NOT_CANCELLABLE']);

      const stranger = await api.customer();
      const foreign = await api.as(stranger.token).post(path(soA.id));
      expect([foreign.status, errorBody(foreign).error.code]).toEqual([404, 'ORDER_NOT_FOUND']);
      const other = await twoSellerOrder();
      const mismatch = await api.as(buyer.token).post(path(other.soA.id));
      expect([mismatch.status, errorBody(mismatch).error.code]).toEqual([404, 'SELLER_ORDER_NOT_FOUND']);

      expect((await api.as(buyer.token).post(path(soA.id), {}, null)).status).toBe(400);
      expect((await api.as(buyer.token).post(path(soA.id), { note: '' })).status).toBe(400);
      expect((await api.as(buyer.token).post(path(soA.id), { reason: 'x' })).status).toBe(400);
      expect((await api.as(a.sellerToken).post(path(soA.id))).status).toBe(403);
    });
  });

  describe('seller accepts and marks ready (UC-OR-3)', () => {
    it('placed → accepted → ready_for_pickup, with the pickup snapshot event; wrong order of steps is 409', async () => {
      const { a, result, soA } = await twoSellerOrder();
      const seller = api.as(a.sellerToken);
      const early = await seller.post(`/seller/orders/${soA.id}/ready`);
      expect([early.status, errorBody(early).error.code]).toEqual([
        409,
        'SELLER_ORDER_INVALID_STATUS_TRANSITION',
      ]);

      const accepted = await seller.post(`/seller/orders/${soA.id}/accept`);
      expect(accepted.status).toBe(200);
      expect(successBody<SellerOrderDto>(accepted).data).toMatchObject({ status: 'accepted' });
      expect(successBody<SellerOrderDto>(accepted).data.acceptedAt).not.toBeNull();
      expect((await orderRow(result.order.id))?.status).toBe('in_progress');
      expect((await seller.post(`/seller/orders/${soA.id}/accept`)).status).toBe(409);

      const ready = await seller.post(`/seller/orders/${soA.id}/ready`);
      expect(successBody<SellerOrderDto>(ready).data).toMatchObject({ status: 'ready_for_pickup' });
      const [event] = await api.eventsOf('seller_order.ready_for_pickup', soA.id);
      expect(event).toMatchObject({
        orderId: result.order.id,
        orderNumber: result.order.orderNumber,
        sellerId: a.sellerId,
        paymentMethod: 'cod',
        codItemsAmount: '300.00',
        orderDeliveryFee: CAIRO_FEE,
        pickup: { phone: '+201221234567', city: 'Cairo', area: 'Nasr City' },
        dropoff: {
          recipientName: 'Mona Ali',
          recipientPhone: '+201001234567',
          governorateName: 'Cairo',
          floor: '3',
        },
      });
      expect((event?.pickup as { businessName: string }).businessName).toMatch(/^Shop /);
    });

    it("another seller's seller order is 404; customers and admins get 403", async () => {
      const { b, soA, buyer } = await twoSellerOrder();
      const res = await api.as(b.sellerToken).post(`/seller/orders/${soA.id}/accept`);
      expect([res.status, errorBody(res).error.code]).toEqual([404, 'SELLER_ORDER_NOT_FOUND']);
      expect((await api.as(buyer.token).post(`/seller/orders/${soA.id}/accept`)).status).toBe(403);
      expect((await api.as(b.sellerToken).post(`/seller/orders/${UNKNOWN_ID}/accept`)).status).toBe(404);
      expect((await api.as(b.sellerToken).post('/seller/orders/nope/accept')).status).toBe(400);
    });
  });

  describe('seller cancels (UC-OR-4, UC-OR-5)', () => {
    it('cancels a whole seller order until pickup', async () => {
      const { a, soA } = await twoSellerOrder();
      const seller = api.as(a.sellerToken);
      await seller.post(`/seller/orders/${soA.id}/accept`);
      await seller.post(`/seller/orders/${soA.id}/ready`);
      const res = await seller.post(`/seller/orders/${soA.id}/cancel`, { note: 'Out of stock after all' });
      expect(successBody<SellerOrderDto>(res).data).toMatchObject({
        status: 'cancelled',
        cancelReason: 'seller_cancelled',
      });
      expect(await api.eventsOf('seller_order.cancelled', soA.id)).toEqual([
        expect.objectContaining({
          previousStatus: 'ready_for_pickup',
          reason: 'seller_cancelled',
          amountCancelled: '300.00',
        }),
      ]);

      const other = await twoSellerOrder();
      await knex()('seller_orders').where({ id: other.soA.id }).update({ status: 'picked_up' });
      const late = await api.as(other.a.sellerToken).post(`/seller/orders/${other.soA.id}/cancel`);
      expect([late.status, errorBody(late).error.code]).toEqual([409, 'SELLER_ORDER_NOT_CANCELLABLE']);
    });

    it('cancels item quantities: line, seller order and order money recomputed, units released, event published', async () => {
      const { a, result, soA } = await twoSellerOrder();
      const itemId = must(soA.items[0]).id;
      const res = await api
        .as(a.sellerToken)
        .post(`/seller/orders/${soA.id}/items/${itemId}/cancel`, { quantity: 2, reason: 'out_of_stock' });
      expect(res.status).toBe(200);
      const view = successBody<SellerOrderDto>(res).data;
      expect(view).toMatchObject({
        status: 'placed',
        subtotal: '100.00',
        commission: '10.00',
        sellerNet: '90.00',
      });
      expect(view.items[0]).toMatchObject({ quantity: 3, cancelledQuantity: 2, lineTotal: '100.00' });
      expect(await orderRow(result.order.id)).toMatchObject({ items_total: '140.00', total: '190.00' });
      expect(await api.stockOf(a.variantId)).toEqual({ on_hand: 10, reserved: 1 });
      expect(await api.eventsOf('seller_order.items_cancelled', soA.id)).toEqual([
        expect.objectContaining({
          lines: [{ orderItemId: itemId, variantId: a.variantId, quantity: 2, amount: '200.00' }],
          amountCancelled: '200.00',
          newSubtotal: '100.00',
          newCommission: '10.00',
          newSellerNet: '90.00',
          reason: 'out_of_stock',
        }),
      ]);
      expect(
        await knex()('order_item_cancellations')
          .where({ order_item_id: itemId })
          .select('quantity', 'reason'),
      ).toEqual([{ quantity: 2, reason: 'out_of_stock' }]);
    });

    it('cancelling the last open units cancels the seller order with the subtotal before it (OR-12)', async () => {
      const { a, soA } = await twoSellerOrder();
      const itemId = must(soA.items[0]).id;
      const cancel = (body: object) =>
        api.as(a.sellerToken).post(`/seller/orders/${soA.id}/items/${itemId}/cancel`, body);
      await cancel({ quantity: 1, reason: 'seller_request' });
      const res = await cancel({ quantity: 2, reason: 'other', note: 'Damaged' });
      expect(successBody<SellerOrderDto>(res).data).toMatchObject({ status: 'cancelled', subtotal: '0.00' });
      expect(await api.eventsOf('seller_order.items_cancelled', soA.id)).toHaveLength(1);
      expect(await api.eventsOf('seller_order.cancelled', soA.id)).toEqual([
        expect.objectContaining({ reason: 'seller_cancelled', amountCancelled: '200.00' }),
      ]);
      expect(await api.stockOf(a.variantId)).toEqual({ on_hand: 10, reserved: 0 });
    });

    it('refuses more than the open quantity, a missing note for "other", and a line of another seller order', async () => {
      const { a, soA, soB } = await twoSellerOrder();
      const itemId = must(soA.items[0]).id;
      const cancel = (path: string, body: object) => api.as(a.sellerToken).post(path, body);
      const mine = `/seller/orders/${soA.id}/items/${itemId}/cancel`;
      const tooMany = await cancel(mine, { quantity: 4, reason: 'out_of_stock' });
      expect([tooMany.status, errorBody(tooMany).error.code]).toEqual([422, 'ITEM_CANCEL_QUANTITY_INVALID']);
      expect((await cancel(mine, { quantity: 1, reason: 'other' })).status).toBe(400);
      expect((await cancel(mine, { quantity: 0, reason: 'out_of_stock' })).status).toBe(400);
      expect((await cancel(mine, { quantity: 1, reason: 'lost' })).status).toBe(400);
      const wrongLine = await cancel(`/seller/orders/${soA.id}/items/${must(soB.items[0]).id}/cancel`, {
        quantity: 1,
        reason: 'out_of_stock',
      });
      expect([wrongLine.status, errorBody(wrongLine).error.code]).toEqual([404, 'ORDER_ITEM_NOT_FOUND']);
    });
  });

  describe('return received (UC-OR-7)', () => {
    it('returning_to_seller → returned_to_seller releases the units and publishes seller_order.returned', async () => {
      const { a, soA } = await twoSellerOrder();
      const seller = api.as(a.sellerToken);
      const early = await seller.post(`/seller/orders/${soA.id}/return-received`);
      expect([early.status, errorBody(early).error.code]).toEqual([
        409,
        'SELLER_ORDER_INVALID_STATUS_TRANSITION',
      ]);

      await knex()('seller_orders').where({ id: soA.id }).update({ status: 'returning_to_seller' });
      const res = await seller.post(`/seller/orders/${soA.id}/return-received`);
      expect(successBody<SellerOrderDto>(res).data).toMatchObject({ status: 'returned_to_seller' });
      expect(successBody<SellerOrderDto>(res).data.returnedAt).not.toBeNull();
      expect(await api.stockOf(a.variantId)).toEqual({ on_hand: 10, reserved: 0 });
      expect(await api.eventsOf('seller_order.returned', soA.id)).toEqual([
        expect.objectContaining({ sellerId: a.sellerId, subtotal: '300.00' }),
      ]);
    });
  });

  describe('seller-acceptance-timeout job (§3.10)', () => {
    it('cancels only placed seller orders past their deadline, as the system', async () => {
      const { result, soA, soB, a } = await twoSellerOrder();
      const past = new Date(Date.now() - 60_000);
      await knex()('seller_orders').where({ id: soA.id }).update({ accept_deadline_at: past });
      const job = timeoutJob();
      expect(await job.run()).toBeGreaterThanOrEqual(1);

      const rows = await knex()('seller_orders')
        .whereIn('id', [soA.id, soB.id])
        .select<
          { id: string; status: string; cancel_reason: string | null; cancelled_by_user_id: string | null }[]
        >('id', 'status', 'cancel_reason', 'cancelled_by_user_id');
      expect(rows.find((r) => r.id === soA.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'seller_acceptance_timeout',
        cancelled_by_user_id: null,
      });
      expect(rows.find((r) => r.id === soB.id)?.status).toBe('placed');
      expect(await api.stockOf(a.variantId)).toEqual({ on_hand: 10, reserved: 0 });
      expect(await orderRow(result.order.id)).toMatchObject({ status: 'placed', items_total: '40.00' });
      const history = await knex()('seller_order_status_history')
        .where({ seller_order_id: soA.id, to_status: 'cancelled' })
        .first<{ actor_role: string; actor_user_id: string | null }>('actor_role', 'actor_user_id');
      expect(history).toEqual({ actor_role: 'system', actor_user_id: null });
      // Nothing left to do: a second run changes nothing.
      const updatedAt = () =>
        knex()('seller_orders').where({ id: soA.id }).first<{ updated_at: Date }>('updated_at');
      const again = await updatedAt();
      await job.run();
      expect(await updatedAt()).toEqual(again);
    });

    it('an accept racing the job: exactly one of them wins', async () => {
      const { a, soA } = await twoSellerOrder();
      await knex()('seller_orders')
        .where({ id: soA.id })
        .update({ accept_deadline_at: new Date(Date.now() - 1_000) });
      const [accept] = await Promise.all([
        api.as(a.sellerToken).post(`/seller/orders/${soA.id}/accept`),
        timeoutJob().run(),
      ]);
      const status = (await knex()('seller_orders').where({ id: soA.id }).first<{ status: string }>('status'))
        ?.status;
      if (accept.status === 200) expect(status).toBe('accepted');
      else {
        expect([accept.status, errorBody(accept).error.code]).toEqual([
          409,
          'SELLER_ORDER_INVALID_STATUS_TRANSITION',
        ]);
        expect(status).toBe('cancelled');
      }
    });
  });

  it('a customer cancel and a seller accept at the same moment: exactly one wins', async () => {
    const { buyer, a, result, soA } = await twoSellerOrder();
    const [cancel, accept] = await Promise.all([
      api.as(buyer.token).post(`/orders/${result.order.id}/seller-orders/${soA.id}/cancel`),
      api.as(a.sellerToken).post(`/seller/orders/${soA.id}/accept`),
    ]);
    expect([cancel.status, accept.status].sort()).toEqual([200, 409]);
  });
});
