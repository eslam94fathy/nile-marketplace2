import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CheckoutResultDto, type OrderDetailDto } from '../../src/app/ordering/dto/order-response.dto';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

const DAY = 86_400_000;
let codes = 0;
const nextCode = () => `ORD-${Date.now().toString(36)}-${++codes}`.toUpperCase();

/* Spec 09 §8.8, spec 19 UC-PR-2, UC-PR-3, OR-31, OR-32: checkout with a coupon, cancellations, release. */
describe('ordering with coupons', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let adminToken: string;
  let freeGovernorateId: string;
  const knex = () => t.infra.db.knex;

  const coupon = async (token: string, path: string, overrides: Record<string, unknown> = {}) => {
    const res = await request(t.app)
      .post(`${API}${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: nextCode(),
        discountType: 'percent',
        discountValue: '0.10',
        minItemsSubtotal: '0.00',
        scope: path.startsWith('/seller') ? 'seller' : 'all',
        startsAt: new Date(Date.now() - DAY).toISOString(),
        endsAt: new Date(Date.now() + DAY).toISOString(),
        perCustomerLimit: 1,
        ...overrides,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return successBody<{ id: string; code: string }>(res).data;
  };
  const platformCoupon = (overrides: Record<string, unknown> = {}) =>
    coupon(adminToken, '/admin/coupons', overrides);
  const checkout = (
    buyer: { token: string; addressId: string },
    expectedTotal: string,
    couponCode?: string,
    paymentMethod = 'cod',
  ) => api.as(buyer.token).checkout({ addressId: buyer.addressId, paymentMethod, expectedTotal, couponCode });
  const redemptionOf = (orderId: string) =>
    knex()('coupon_redemptions').where({ order_id: orderId }).first<{ status: string } | undefined>('status');
  const usesOf = async (couponId: string) =>
    (await knex()('coupons').where({ id: couponId }).first<{ redemption_count: number }>('redemption_count'))
      .redemption_count;

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
    // Before anything reads (and caches) the governorates.
    const other = await knex()('governorates').whereNot({ id: api.cairoId() }).first<{ id: string }>('id');
    freeGovernorateId = other.id;
    await knex()('governorates').where({ id: freeGovernorateId }).update({ delivery_fee: '0.00' });
    adminToken = await signTestAccessToken({ sub: await api.fx.insertUser('admin'), role: 'admin' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('a platform coupon: discounted lines, commission on the undiscounted subtotal, one redemption', async () => {
    const a = await api.listedVariant({ price: '100.00' });
    const b = await api.listedVariant({ price: '50.00' });
    const buyer = await api.customer();
    await api.fillCart(buyer.customerId, [
      { variantId: a.variantId, quantity: 2 },
      { variantId: b.variantId, quantity: 1 },
    ]);
    const c = await platformCoupon();

    // The undiscounted total is refused: the client must show the discounted one (S-8).
    const stale = await checkout(buyer, '300.00', c.code);
    expect(stale.status).toBe(409);
    expect(errorBody(stale).error.details?.[0]?.value).toBe('275.00');

    const res = await checkout(buyer, '275.00', c.code.toLowerCase());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = successBody<CheckoutResultDto>(res).data.order;
    expect(order).toMatchObject({
      itemsTotal: '225.00',
      deliveryFee: '50.00',
      total: '275.00',
      coupon: { code: c.code, discountTotal: '25.00' },
    });
    const soA = order.sellerOrders.find((s) => s.sellerId === a.sellerId);
    expect(soA).toMatchObject({ subtotal: '200.00', discountAmount: '20.00', discountFunding: 'platform' });
    expect(soA?.items[0]).toMatchObject({
      lineTotal: '200.00',
      discountAmount: '20.00',
      paidTotal: '180.00',
    });

    const rows = await knex()('seller_orders')
      .where({ order_id: order.id })
      .select<{ seller_id: string; commission: string; seller_net: string }[]>(
        'seller_id',
        'commission',
        'seller_net',
      );
    expect(rows.find((r) => r.seller_id === a.sellerId)).toMatchObject({
      commission: '20.00',
      seller_net: '180.00',
    });
    expect(await redemptionOf(order.id)).toEqual({ status: 'active' });
    expect(await usesOf(c.id)).toBe(1);
    const payment = await knex()('payments')
      .where({ order_id: order.id })
      .first<{ amount: string }>('amount');
    expect(payment.amount).toBe('275.00');
    expect(await api.eventsOf('order.placed', order.id)).toEqual([
      expect.objectContaining({ itemsTotal: '225.00', total: '275.00' }) as unknown,
    ]);
  });

  it('a seller coupon: only its products, commission on the discounted subtotal (R-17, PR-7)', async () => {
    const a = await api.listedVariant({ price: '100.00' });
    const other = await api.listedVariant({ price: '100.00' });
    const buyer = await api.customer();
    await api.fillCart(buyer.customerId, [
      { variantId: a.variantId, quantity: 1 },
      { variantId: other.variantId, quantity: 1 },
    ]);
    const c = await coupon(a.sellerToken, '/seller/coupons', { discountValue: '0.20' });
    const res = await checkout(buyer, '230.00', c.code);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = successBody<CheckoutResultDto>(res).data.order;
    const so = order.sellerOrders.find((s) => s.sellerId === a.sellerId);
    expect(so).toMatchObject({ discountAmount: '20.00', discountFunding: 'seller' });
    expect(order.sellerOrders.find((s) => s.sellerId === other.sellerId)).toMatchObject({
      discountAmount: '0.00',
      discountFunding: null,
    });
    const mine = await api.as(a.sellerToken).get(`/seller/orders/${so?.id ?? ''}`);
    expect(successBody(mine).data).toMatchObject({
      subtotal: '100.00',
      discountAmount: '20.00',
      discountFunding: 'seller',
      commission: '8.00',
      sellerNet: '72.00',
    });
  });

  it('a coupon error rolls the whole checkout back', async () => {
    const a = await api.listedVariant({ price: '100.00' });
    const buyer = await api.customer();
    await api.fillCart(buyer.customerId, [{ variantId: a.variantId, quantity: 1 }]);
    const big = await platformCoupon({ minItemsSubtotal: '500.00' });
    const res = await checkout(buyer, '140.00', big.code);
    expect(res.status).toBe(422);
    expect(errorBody(res).error.code).toBe('COUPON_MIN_SUBTOTAL_NOT_MET');
    expect(await knex()('orders').where({ customer_id: buyer.customerId }).first()).toBeUndefined();
    expect((await api.stockOf(a.variantId)).reserved).toBe(0);
    // The same cart checks out without the coupon.
    expect((await checkout(buyer, '150.00')).status).toBe(201);
  });

  it('Kashier at a total of 0.00 is refused; COD at 0.00 is placed (OR-32)', async () => {
    const a = await api.listedVariant({ price: '30.00' });
    const c = await platformCoupon({ discountType: 'fixed', discountValue: '30.00', perCustomerLimit: 5 });
    const buyer = await api.customer(freeGovernorateId);
    await api.fillCart(buyer.customerId, [{ variantId: a.variantId, quantity: 1 }]);
    const kashier = await checkout(buyer, '0.00', c.code, 'kashier');
    expect(kashier.status).toBe(422);
    expect(errorBody(kashier).error.code).toBe('KASHIER_TOTAL_ZERO');
    const cod = await checkout(buyer, '0.00', c.code);
    expect(cod.status, JSON.stringify(cod.body)).toBe(201);
    expect(successBody<CheckoutResultDto>(cod).data.order).toMatchObject({
      itemsTotal: '0.00',
      total: '0.00',
    });
  });

  it('a global limit lets exactly that many parallel checkouts through', async () => {
    const listed = await api.listedVariant({ price: '100.00', onHand: 50 });
    const c = await platformCoupon({ globalLimit: 2 });
    const buyers = await Promise.all(Array.from({ length: 5 }, () => api.customer()));
    for (const buyer of buyers)
      await api.fillCart(buyer.customerId, [{ variantId: listed.variantId, quantity: 1 }]);
    const results = await Promise.all(buyers.map((buyer) => checkout(buyer, '140.00', c.code)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(422);
      expect(errorBody(r).error.code).toBe('COUPON_LIMIT_REACHED');
    }
    expect(await usesOf(c.id)).toBe(2);
    expect((await api.stockOf(listed.variantId)).reserved).toBe(2);
  });

  it('a partial item cancellation keeps the coupon; amounts are paid amounts (OR-31)', async () => {
    const a = await api.listedVariant({ price: '100.00' });
    const buyer = await api.customer();
    await api.fillCart(buyer.customerId, [{ variantId: a.variantId, quantity: 2 }]);
    const c = await platformCoupon();
    const order = successBody<CheckoutResultDto>(await checkout(buyer, '230.00', c.code)).data.order;
    const so = order.sellerOrders[0];
    const itemId = so?.items[0]?.id ?? '';
    const res = await api
      .as(a.sellerToken)
      .post(`/seller/orders/${so?.id ?? ''}/items/${itemId}/cancel`, { quantity: 1, reason: 'out_of_stock' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await api.eventsOf('seller_order.items_cancelled', so?.id ?? '')).toEqual([
      expect.objectContaining({
        lines: [expect.objectContaining({ quantity: 1, amount: '90.00' })],
        amountCancelled: '90.00',
        newSubtotal: '100.00',
        newPaidSubtotal: '90.00',
        newCommission: '10.00',
        newSellerNet: '90.00',
      }) as unknown,
    ]);
    const detail = successBody<OrderDetailDto>(await api.as(buyer.token).get(`/orders/${order.id}`)).data;
    expect(detail).toMatchObject({
      itemsTotal: '90.00',
      total: '140.00',
      coupon: { discountTotal: '10.00' },
    });
    expect(detail.sellerOrders[0]?.items[0]).toMatchObject({ discountAmount: '10.00', paidTotal: '90.00' });
    expect(await redemptionOf(order.id)).toEqual({ status: 'active' });
  });

  it('cancelling every seller order releases the redemption; a partly cancelled order keeps it (R-18)', async () => {
    const a = await api.listedVariant({ price: '100.00' });
    const b = await api.listedVariant({ price: '100.00' });
    const buyer = await api.customer();
    await api.fillCart(buyer.customerId, [
      { variantId: a.variantId, quantity: 1 },
      { variantId: b.variantId, quantity: 1 },
    ]);
    const c = await platformCoupon();
    const order = successBody<CheckoutResultDto>(await checkout(buyer, '230.00', c.code)).data.order;
    const cancel = (sellerOrderId: string) =>
      api.as(buyer.token).post(`/orders/${order.id}/seller-orders/${sellerOrderId}/cancel`, {});
    const [first, second] = order.sellerOrders;

    expect((await cancel(first?.id ?? '')).status).toBe(200);
    expect(await api.eventsOf('seller_order.cancelled', first?.id ?? '')).toEqual([
      expect.objectContaining({ amountCancelled: '90.00' }) as unknown,
    ]);
    expect(await redemptionOf(order.id)).toEqual({ status: 'active' });
    expect(await usesOf(c.id)).toBe(1);

    expect((await cancel(second?.id ?? '')).status).toBe(200);
    expect(await redemptionOf(order.id)).toEqual({ status: 'released' });
    expect(await usesOf(c.id)).toBe(0);
    // The customer may use the coupon again (per-customer limit 1).
    await api.fillCart(buyer.customerId, [{ variantId: a.variantId, quantity: 1 }]);
    expect((await checkout(buyer, '140.00', c.code)).status).toBe(201);
  });

  it('without a coupon every amount equals the R1 amount', async () => {
    const a = await api.listedVariant({ price: '100.00' });
    const buyer = await api.customer();
    await api.fillCart(buyer.customerId, [{ variantId: a.variantId, quantity: 2 }]);
    const order = successBody<CheckoutResultDto>(await checkout(buyer, '250.00')).data.order;
    expect(order).toMatchObject({ itemsTotal: '200.00', total: '250.00', coupon: null });
    const so = order.sellerOrders[0];
    const cancelled = await api
      .as(a.sellerToken)
      .post(`/seller/orders/${so?.id ?? ''}/items/${so?.items[0]?.id ?? ''}/cancel`, {
        quantity: 1,
        reason: 'out_of_stock',
      });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const [event] = await api.eventsOf('seller_order.items_cancelled', so?.id ?? '');
    expect(event).toMatchObject({
      amountCancelled: '100.00',
      newSubtotal: '100.00',
      newPaidSubtotal: '100.00',
    });
    expect(await redemptionOf(order.id)).toBeUndefined();
  });
});
