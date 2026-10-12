import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AdminOrderDetailDto,
  type AdminOrderSummaryDto,
  type CheckoutResultDto,
  type OrderDetailDto,
  type OrderSummaryDto,
  type SellerOrderDto,
} from '../../src/app/ordering/dto/order-response.dto';
import { errorBody, successBody } from '../helpers/http';
import { signTestAccessToken } from '../helpers/jwt';
import { CAIRO_FEE as FEE, orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/* Spec 09 UC-OR-1 and the order views (§4.1.3, §4.2, §4.3) over HTTP, on real Postgres + Redis. */
describe('ordering: COD checkout and order views', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let cairoId: string;
  let alexandriaId: string;
  let adminToken: string;

  const knex = () => t.infra.db.knex;
  const fx = () => api.fx;
  const as = (token: string | undefined) => api.as(token);
  const customer = (governorateId?: string) => api.customer(governorateId);
  const listedVariant = (options?: { price?: string; onHand?: number }) => api.listedVariant(options);
  const fillCart = (customerId: string, lines: { variantId: string; quantity: number }[]) =>
    api.fillCart(customerId, lines);
  const stockOf = (variantId: string) => api.stockOf(variantId);
  const cartLineCount = async (customerId: string) =>
    Number(
      (
        await knex()('cart_items as i')
          .join('carts as c', 'c.id', 'i.cart_id')
          .where('c.customer_id', customerId)
          .count<{ count: string }[]>('*')
      )[0]?.count,
    );
  const orderCount = async (customerId: string) =>
    Number(
      (await knex()('orders').where({ customer_id: customerId }).count<{ count: string }[]>('*'))[0]?.count,
    );

  /** A customer who checked out one line of each of two sellers: 2 × 100.00 and 1 × 33.33. */
  async function placedOrder() {
    const buyer = await customer();
    const a = await listedVariant({ price: '100.00' });
    const b = await listedVariant({ price: '33.33' });
    const result = await api.placeOrder(
      buyer,
      [
        { variantId: a.variantId, quantity: 2 },
        { variantId: b.variantId, quantity: 1 },
      ],
      '283.33',
    );
    return { buyer, a, b, result };
  }

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
    cairoId = api.cairoId();
    alexandriaId = (await knex()('governorates').where({ code: 'EG-ALX' }).first<{ id: string }>('id')).id;
    adminToken = await signTestAccessToken({ sub: await fx().insertUser('admin'), role: 'admin' });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('POST /checkout', () => {
    it('places a COD order split per seller: snapshots, money, reserved stock, empty cart, payment, event', async () => {
      const { buyer, a, b, result } = await placedOrder();
      const { order } = result;
      expect(result.kashier).toBeNull();
      expect(order).toMatchObject({
        status: 'placed',
        paymentMethod: 'cod',
        paymentStatus: 'pending',
        itemsTotal: '233.33',
        deliveryFee: FEE,
        total: '283.33',
        shippingAddress: {
          governorateId: cairoId,
          governorateName: 'Cairo',
          recipientName: 'Mona Ali',
          floor: '3',
        },
        paymentExpiresAt: null,
      });
      expect(order.orderNumber).toMatch(/^NM-\d{9}$/);
      expect(order.sellerOrders.map((s) => [s.sellerId, s.subtotal, s.status, s.canCancel])).toEqual([
        [a.sellerId, '200.00', 'placed', true],
        [b.sellerId, '33.33', 'placed', true],
      ]);
      expect(order.sellerOrders[0]?.items[0]).toMatchObject({
        variantId: a.variantId,
        unitPrice: '100.00',
        quantity: 2,
        cancelledQuantity: 0,
        lineTotal: '200.00',
      });
      expect(order.sellerOrders[0]?.timeline.map((e) => e.status)).toEqual(['placed']);

      const sellerOrders = await knex()('seller_orders')
        .where({ order_id: order.id })
        .orderBy('created_at')
        .select<{ commission: string; seller_net: string; accept_deadline_at: Date }[]>(
          'commission',
          'seller_net',
          'accept_deadline_at',
        );
      // 33.33 × 0.1 = 3.333 → 3.33
      expect(sellerOrders.map((s) => [s.commission, s.seller_net])).toEqual([
        ['20.00', '180.00'],
        ['3.33', '30.00'],
      ]);
      const hoursToDeadline = (must(sellerOrders[0]).accept_deadline_at.getTime() - Date.now()) / 3_600_000;
      expect(hoursToDeadline).toBeGreaterThan(23.9);
      expect(hoursToDeadline).toBeLessThanOrEqual(24);

      expect(await stockOf(a.variantId)).toEqual({ on_hand: 10, reserved: 2 });
      expect(await stockOf(b.variantId)).toEqual({ on_hand: 10, reserved: 1 });
      expect(await cartLineCount(buyer.customerId)).toBe(0);
      expect(
        await knex()('payments').where({ order_id: order.id }).first('method', 'status', 'amount'),
      ).toEqual({ method: 'cod', status: 'pending', amount: '283.33' });
      const [event] = await knex()('events_outbox')
        .where({ event_type: 'order.placed', aggregate_id: order.id })
        .select<{ payload: Record<string, unknown> }[]>('payload');
      expect(event?.payload).toMatchObject({
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerId: buyer.customerId,
        paymentMethod: 'cod',
        itemsTotal: '233.33',
        deliveryFee: FEE,
        total: '283.33',
      });
      expect((event?.payload.sellerOrderIds as string[]).sort()).toEqual(
        order.sellerOrders.map((s) => s.id).sort(),
      );
    });

    it('replays the same response for a repeated Idempotency-Key and creates one order', async () => {
      const buyer = await customer();
      const { variantId } = await listedVariant();
      await fillCart(buyer.customerId, [{ variantId, quantity: 1 }]);
      const body = { addressId: buyer.addressId, paymentMethod: 'cod', expectedTotal: '150.00' };
      const key = randomUUID();
      const first = await as(buyer.token).checkout(body, key);
      const second = await as(buyer.token).checkout(body, key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(successBody<CheckoutResultDto>(second).data.order.id).toBe(
        successBody<CheckoutResultDto>(first).data.order.id,
      );
      expect(await orderCount(buyer.customerId)).toBe(1);
    });

    it('validation: Idempotency-Key required, COD only for now, strict body', async () => {
      const buyer = await customer();
      const valid = { addressId: buyer.addressId, paymentMethod: 'cod', expectedTotal: '1.00' };
      expect(errorBody(await as(buyer.token).checkout(valid, null)).error.code).toBe(
        'IDEMPOTENCY_KEY_REQUIRED',
      );
      for (const body of [
        { ...valid, paymentMethod: 'kashier' },
        { ...valid, addressId: 'nope' },
        { ...valid, expectedTotal: '1.005' },
        { ...valid, expectedTotal: 1 },
        { ...valid, currency: 'EGP' },
        { addressId: buyer.addressId, paymentMethod: 'cod' },
      ]) {
        const res = await as(buyer.token).checkout(body);
        expect(res.status).toBe(400);
        expect(errorBody(res).error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('authz: anonymous 401, seller and admin 403', async () => {
      const body = { addressId: UNKNOWN_ID, paymentMethod: 'cod', expectedTotal: '1.00' };
      expect((await as(undefined).checkout(body)).status).toBe(401);
      const sellerToken = await signTestAccessToken({
        sub: (await fx().insertSeller()).userId,
        role: 'seller',
      });
      expect((await as(sellerToken).checkout(body)).status).toBe(403);
      expect((await as(adminToken).checkout(body)).status).toBe(403);
    });

    it('refuses an unknown or foreign address (422), an undeliverable governorate and an empty cart', async () => {
      const buyer = await customer();
      const other = await customer();
      const { variantId } = await listedVariant();
      await fillCart(buyer.customerId, [{ variantId, quantity: 1 }]);
      for (const addressId of [UNKNOWN_ID, other.addressId]) {
        const res = await as(buyer.token).checkout({
          addressId,
          paymentMethod: 'cod',
          expectedTotal: '150.00',
        });
        expect(res.status).toBe(422);
        expect(errorBody(res).error.code).toBe('ADDRESS_NOT_FOUND');
      }

      const faraway = await customer(alexandriaId);
      await fillCart(faraway.customerId, [{ variantId, quantity: 1 }]);
      const undeliverable = await as(faraway.token).checkout({
        addressId: faraway.addressId,
        paymentMethod: 'cod',
        expectedTotal: '150.00',
      });
      expect([undeliverable.status, errorBody(undeliverable).error.code]).toEqual([
        422,
        'GOVERNORATE_NOT_DELIVERABLE',
      ]);

      const empty = await customer();
      const res = await as(empty.token).checkout({
        addressId: empty.addressId,
        paymentMethod: 'cod',
        expectedTotal: FEE,
      });
      expect([res.status, errorBody(res).error.code]).toEqual([422, 'CART_EMPTY']);
    });

    it('ORDER_TOTAL_CHANGED carries the current total, and nothing is written', async () => {
      const buyer = await customer();
      const { variantId } = await listedVariant({ price: '20.00' });
      await fillCart(buyer.customerId, [{ variantId, quantity: 2 }]);
      const res = await as(buyer.token).checkout({
        addressId: buyer.addressId,
        paymentMethod: 'cod',
        expectedTotal: '80.00',
      });
      expect(res.status).toBe(409);
      expect(errorBody(res).error).toMatchObject({
        code: 'ORDER_TOTAL_CHANGED',
        details: [{ field: 'expectedTotal', value: '90.00', constraint: 'current' }],
      });
      expect(await orderCount(buyer.customerId)).toBe(0);
      expect(await cartLineCount(buyer.customerId)).toBe(1);
    });

    it('CART_HAS_ISSUES lists every variant that can no longer be bought', async () => {
      const buyer = await customer();
      const fine = await listedVariant();
      const inactive = await listedVariant();
      const suspended = await listedVariant();
      await knex()('product_variants').where({ id: inactive.variantId }).update({ status: 'inactive' });
      await knex()('sellers').where({ id: suspended.sellerId }).update({ status: 'suspended' });
      await fillCart(
        buyer.customerId,
        [fine, inactive, suspended].map((v) => ({ variantId: v.variantId, quantity: 1 })),
      );
      const res = await as(buyer.token).checkout({
        addressId: buyer.addressId,
        paymentMethod: 'cod',
        expectedTotal: '350.00',
      });
      expect(res.status).toBe(409);
      expect(errorBody(res).error.code).toBe('CART_HAS_ISSUES');
      expect(
        errorBody(res)
          .error.details?.map((d) => d.value)
          .sort(),
      ).toEqual([inactive.variantId, suspended.variantId].sort());
    });

    it('INSUFFICIENT_STOCK rolls everything back: no order, cart intact, stock unchanged', async () => {
      const buyer = await customer();
      const plenty = await listedVariant({ onHand: 5 });
      const scarce = await listedVariant({ onHand: 1 });
      await fillCart(buyer.customerId, [
        { variantId: plenty.variantId, quantity: 2 },
        { variantId: scarce.variantId, quantity: 2 },
      ]);
      const res = await as(buyer.token).checkout({
        addressId: buyer.addressId,
        paymentMethod: 'cod',
        expectedTotal: '450.00',
      });
      expect(res.status).toBe(409);
      expect(errorBody(res).error).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        details: [{ field: 'variantId', value: scarce.variantId, message: 'available: 1' }],
      });
      expect(await orderCount(buyer.customerId)).toBe(0);
      expect(await cartLineCount(buyer.customerId)).toBe(2);
      expect(await stockOf(plenty.variantId)).toEqual({ on_hand: 5, reserved: 0 });
      expect(
        await knex()('events_outbox')
          .where({ event_type: 'order.placed' })
          .whereRaw(`payload->>'customerId' = ?`, [buyer.customerId]),
      ).toEqual([]);
    });

    it('two customers racing for the last unit: one order, one INSUFFICIENT_STOCK', async () => {
      const { variantId } = await listedVariant({ onHand: 1 });
      const buyers = [await customer(), await customer()];
      for (const buyer of buyers) await fillCart(buyer.customerId, [{ variantId, quantity: 1 }]);
      const results = await Promise.all(
        buyers.map((buyer) =>
          as(buyer.token).checkout({
            addressId: buyer.addressId,
            paymentMethod: 'cod',
            expectedTotal: '150.00',
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(errorBody(must(results.find((r) => r.status === 409))).error.code).toBe('INSUFFICIENT_STOCK');
      expect(await stockOf(variantId)).toEqual({ on_hand: 1, reserved: 1 });
    });
  });

  describe('customer views', () => {
    it('lists my orders newest first with counts, filters by status, and shows the detail', async () => {
      const { buyer, result } = await placedOrder();
      const second = await listedVariant({ price: '10.00' });
      await fillCart(buyer.customerId, [{ variantId: second.variantId, quantity: 4 }]);
      const newer = await as(buyer.token).checkout({
        addressId: buyer.addressId,
        paymentMethod: 'cod',
        expectedTotal: '90.00',
      });
      expect(newer.status).toBe(201);

      const list = successBody<OrderSummaryDto[]>(await as(buyer.token).get('/orders'));
      expect(list.data.map((o) => [o.total, o.itemCount, o.sellerOrderCount])).toEqual([
        ['90.00', 4, 1],
        ['283.33', 3, 2],
      ]);
      expect(list.meta).toMatchObject({ hasMore: false, nextCursor: null });
      expect(
        successBody<OrderSummaryDto[]>(await as(buyer.token).get('/orders?status[eq]=cancelled')).data,
      ).toEqual([]);

      const detail = successBody<OrderDetailDto>(
        await as(buyer.token).get(`/orders/${result.order.id}`),
      ).data;
      expect(detail).toEqual(result.order);
    });

    it("another customer's order or an unknown id is 404; bad ids and filters are 400; other roles 403", async () => {
      const { result } = await placedOrder();
      const stranger = await customer();
      for (const id of [result.order.id, UNKNOWN_ID]) {
        const res = await as(stranger.token).get(`/orders/${id}`);
        expect([res.status, errorBody(res).error.code]).toEqual([404, 'ORDER_NOT_FOUND']);
      }
      expect((await as(stranger.token).get('/orders/nope')).status).toBe(400);
      expect((await as(stranger.token).get('/orders?status[eq]=shipped')).status).toBe(400);
      expect((await as(stranger.token).get('/orders?total[eq]=1')).status).toBe(400);
      expect((await as(adminToken).get('/orders')).status).toBe(403);
      expect((await as(undefined).get('/orders')).status).toBe(401);
    });
  });

  describe('seller views', () => {
    it('a seller sees its own seller orders without customer details, and never pending_payment ones', async () => {
      const { a, b, result } = await placedOrder();
      const sellerToken = await signTestAccessToken({ sub: a.sellerUserId, role: 'seller' });
      const list = successBody<SellerOrderDto[]>(await as(sellerToken).get('/seller/orders')).data;
      expect(list).toHaveLength(1);
      const mine = must(list[0]);
      expect(mine).toMatchObject({
        orderId: result.order.id,
        orderNumber: result.order.orderNumber,
        status: 'placed',
        paymentMethod: 'cod',
        subtotal: '200.00',
        commissionRate: '0.1000',
        commission: '20.00',
        sellerNet: '180.00',
        dropoffGovernorate: { id: cairoId, name: 'Cairo' },
        cancelReason: null,
      });
      expect(JSON.stringify(mine)).not.toMatch(/Mona|\+2010|Road 9/);
      expect(
        successBody<SellerOrderDto>(await as(sellerToken).get(`/seller/orders/${mine.id}`)).data,
      ).toEqual(mine);

      const otherSellerOrder = must(result.order.sellerOrders.find((s) => s.sellerId === b.sellerId));
      const foreign = await as(sellerToken).get(`/seller/orders/${otherSellerOrder.id}`);
      expect([foreign.status, errorBody(foreign).error.code]).toEqual([404, 'SELLER_ORDER_NOT_FOUND']);

      await knex()('seller_orders').where({ id: mine.id }).update({ status: 'pending_payment' });
      expect(successBody<SellerOrderDto[]>(await as(sellerToken).get('/seller/orders')).data).toEqual([]);
      expect((await as(sellerToken).get(`/seller/orders/${mine.id}`)).status).toBe(404);
      expect((await as(sellerToken).get('/seller/orders?status[eq]=pending_payment')).status).toBe(400);
    });

    it('customers and admins cannot use the seller routes', async () => {
      const buyer = await customer();
      expect((await as(buyer.token).get('/seller/orders')).status).toBe(403);
      expect((await as(adminToken).get('/seller/orders')).status).toBe(403);
    });
  });

  describe('admin views', () => {
    it('filters by order number and customer, and shows money and full histories', async () => {
      const { buyer, result } = await placedOrder();
      const byNumber = successBody<AdminOrderSummaryDto[]>(
        await as(adminToken).get(`/admin/orders?orderNumber[eq]=${result.order.orderNumber}`),
      ).data;
      expect(byNumber.map((o) => [o.id, o.customerId])).toEqual([[result.order.id, buyer.customerId]]);
      const byCustomer = successBody<AdminOrderSummaryDto[]>(
        await as(adminToken).get(`/admin/orders?customerId[eq]=${buyer.customerId}`),
      ).data;
      expect(byCustomer.map((o) => o.id)).toEqual([result.order.id]);

      const detail = successBody<AdminOrderDetailDto>(
        await as(adminToken).get(`/admin/orders/${result.order.id}`),
      ).data;
      expect(detail.customerId).toBe(buyer.customerId);
      expect(detail.statusHistory).toEqual([
        expect.objectContaining({
          fromStatus: null,
          toStatus: 'placed',
          actorRole: 'customer',
          actorUserId: buyer.userId,
        }),
      ]);
      expect(
        detail.sellerOrders.map((s) => [s.commission, s.sellerNet, s.cancelReason, s.statusHistory.length]),
      ).toEqual([
        ['20.00', '180.00', null, 1],
        ['3.33', '30.00', null, 1],
      ]);
      expect((await as(adminToken).get(`/admin/orders/${UNKNOWN_ID}`)).status).toBe(404);
      expect((await as(buyer.token).get('/admin/orders')).status).toBe(403);
    });

    it('pages without gaps or duplicates', async () => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await as(adminToken).get(`/admin/orders?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        const page = successBody<AdminOrderSummaryDto[]>(res);
        ids.push(...page.data.map((o) => o.id));
        cursor = page.meta?.nextCursor ?? null;
      } while (cursor);
      const total = Number((await knex()('orders').count<{ count: string }[]>('*'))[0]?.count);
      expect(ids).toHaveLength(total);
      expect(new Set(ids).size).toBe(total);
    });
  });
});
