import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

interface QuoteBody {
  code: string;
  discountTotal: string;
  sellerOrders: { sellerId: string; discount: string }[];
  lines: { variantId: string; discount: string }[];
  itemsTotalAfterDiscount: string;
}

const DAY = 86_400_000;
const PREVIEW_LIMIT = 5;
let codes = 0;
const nextCode = () => `PREV-${Date.now().toString(36)}-${++codes}`.toUpperCase();

/* Spec 08 §8, spec 19 UC-PR-1 (PR-1, PR-6): the coupon preview of the cart. */
describe('cart coupon preview', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let adminToken: string;
  const knex = () => t.infra.db.knex;

  const preview = (token: string, code: unknown) =>
    request(t.app).post(`${API}/cart/coupon-preview`).set('Authorization', `Bearer ${token}`).send({ code });
  const platformCoupon = async (overrides: Record<string, unknown> = {}) => {
    const res = await request(t.app)
      .post(`${API}/admin/coupons`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: nextCode(),
        discountType: 'percent',
        discountValue: '0.10',
        minItemsSubtotal: '0.00',
        scope: 'all',
        startsAt: new Date(Date.now() - DAY).toISOString(),
        endsAt: new Date(Date.now() + DAY).toISOString(),
        perCustomerLimit: 1,
        ...overrides,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return successBody<{ id: string; code: string }>(res).data;
  };

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { RATE_LIMIT_COUPON_PREVIEW_POINTS: String(PREVIEW_LIMIT) } });
    api = orderingApi(t);
    await api.init();
    adminToken = await signTestAccessToken({ sub: await api.fx.insertUser('admin'), role: 'admin' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('quotes the cart without its issue lines, per seller and line, and stores nothing', async () => {
    const a = await api.listedVariant({ price: '100.00' });
    const b = await api.listedVariant({ price: '33.35' });
    const gone = await api.listedVariant({ price: '500.00' });
    const buyer = await api.customer();
    await api.fillCart(buyer.customerId, [
      { variantId: a.variantId, quantity: 1 },
      { variantId: b.variantId, quantity: 1 },
      { variantId: gone.variantId, quantity: 1 },
    ]);
    await knex()('product_variants').where({ id: gone.variantId }).update({ status: 'inactive' });
    const coupon = await platformCoupon();

    const res = await preview(buyer.token, coupon.code.toLowerCase());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(successBody<QuoteBody>(res).data).toEqual({
      code: coupon.code,
      discountTotal: '13.34',
      sellerOrders: [
        { sellerId: a.sellerId, discount: '10.00' },
        { sellerId: b.sellerId, discount: '3.34' },
      ],
      lines: [
        { variantId: a.variantId, discount: '10.00' },
        { variantId: b.variantId, discount: '3.34' },
      ],
      itemsTotalAfterDiscount: '120.01',
    });
    const redemptions = await knex()('coupon_redemptions')
      .where({ coupon_id: coupon.id })
      .count<{ count: string }[]>({
        count: '*',
      });
    expect(Number(redemptions[0]?.count)).toBe(0);
  });

  it('answers CART_EMPTY without lines a coupon could apply to, and the coupon codes otherwise', async () => {
    const coupon = await platformCoupon();
    const buyer = await api.customer();
    const empty = await preview(buyer.token, coupon.code);
    expect(empty.status).toBe(422);
    expect(errorBody(empty).error.code).toBe('CART_EMPTY');

    const listed = await api.listedVariant();
    await api.fillCart(buyer.customerId, [{ variantId: listed.variantId, quantity: 1 }]);
    const unknown = await preview(buyer.token, 'NO-SUCH-CODE');
    expect(unknown.status).toBe(422);
    expect(errorBody(unknown).error.code).toBe('COUPON_NOT_FOUND');
    const big = await platformCoupon({ minItemsSubtotal: '1000.00' });
    const short = await preview(buyer.token, big.code);
    expect(errorBody(short).error.code).toBe('COUPON_MIN_SUBTOTAL_NOT_MET');
    expect(errorBody(short).error.details?.[0]?.value).toBe('900.00');

    await knex()('inventory_items').where({ variant_id: listed.variantId }).update({ on_hand: 0 });
    expect(errorBody(await preview(buyer.token, coupon.code)).error.code).toBe('CART_EMPTY');
  });

  it('validates the body and the caller', async () => {
    const buyer = await api.customer();
    expect((await preview(buyer.token, 'AB')).status).toBe(400);
    expect((await preview(buyer.token, 42)).status).toBe(400);
    const seller = await api.listedVariant();
    expect((await preview(seller.sellerToken, 'SAVE-10')).status).toBe(403);
    expect((await request(t.app).post(`${API}/cart/coupon-preview`).send({ code: 'SAVE-10' })).status).toBe(
      401,
    );
  });

  it('fails closed while Redis is down: 503, never an unlimited guess (PR-23)', async () => {
    const fresh = await startTestApp();
    try {
      const freshApi = orderingApi(fresh);
      await freshApi.init();
      const buyer = await freshApi.customer();
      fresh.infra.redis.disconnect();
      const res = await request(fresh.app)
        .post(`${API}/cart/coupon-preview`)
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({ code: 'GUESS-1' });
      expect([res.status, errorBody(res).error.code]).toEqual([503, 'SERVICE_UNAVAILABLE']);
    } finally {
      await fresh.close();
    }
  }, 120_000);

  it('limits previews per user with coupon-preview (PR-6)', async () => {
    const buyer = await api.customer();
    for (let i = 0; i < PREVIEW_LIMIT; i += 1)
      expect((await preview(buyer.token, 'GUESS-1')).status).toBe(422);
    const limited = await preview(buyer.token, 'GUESS-2');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    // Another customer has their own counter.
    expect((await preview((await api.customer()).token, 'GUESS-3')).status).toBe(422);
  });
});
