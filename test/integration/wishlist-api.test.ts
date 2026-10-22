import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';
/** WISHLIST_MAX_ITEMS in the test env. */
const MAX_ITEMS = 5;

interface WishlistItem {
  productId: string;
  addedAt: string;
  product: { id: string; available: boolean; rating: { avg: string | null; count: number } };
}

/* Spec 04 §8 (UC-CU-3…UC-CU-5, WL-1, WL-2): the customer's wishlist on real Postgres. */
describe('wishlist', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  const knex = () => t.infra.db.knex;

  const call = (token: string, method: 'get' | 'put' | 'delete', path: string) =>
    request(t.app)[method](`${API}${path}`).set('Authorization', `Bearer ${token}`);
  const visibleProduct = async () => (await api.listedVariant()).productId;

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
  });
  afterAll(async () => {
    await t.close();
  });

  it('adds, lists newest first with product cards, lists ids, and removes; both writes are idempotent', async () => {
    const buyer = await api.customer();
    const first = await visibleProduct();
    const second = await visibleProduct();
    expect((await call(buyer.token, 'put', `/me/wishlist/${first}`)).status).toBe(204);
    expect((await call(buyer.token, 'put', `/me/wishlist/${second}`)).status).toBe(204);
    expect((await call(buyer.token, 'put', `/me/wishlist/${first}`)).status).toBe(204);

    const list = successBody<WishlistItem[]>(await call(buyer.token, 'get', '/me/wishlist')).data;
    expect(list.map((i) => i.productId)).toEqual([second, first]);
    expect(list[0]?.product).toMatchObject({ id: second, available: true, rating: { avg: null, count: 0 } });
    expect(successBody(await call(buyer.token, 'get', '/me/wishlist/product-ids')).data).toEqual({
      productIds: [second, first],
    });

    const page = await call(buyer.token, 'get', '/me/wishlist?limit=1');
    const cursor = successBody<unknown[]>(page).meta?.nextCursor ?? '';
    const next = successBody<WishlistItem[]>(
      await call(buyer.token, 'get', `/me/wishlist?limit=1&cursor=${cursor}`),
    ).data;
    expect(next.map((i) => i.productId)).toEqual([first]);

    expect((await call(buyer.token, 'delete', `/me/wishlist/${first}`)).status).toBe(204);
    expect((await call(buyer.token, 'delete', `/me/wishlist/${first}`)).status).toBe(204);
    expect(successBody(await call(buyer.token, 'get', '/me/wishlist/product-ids')).data).toEqual({
      productIds: [second],
    });
    expect((await call(buyer.token, 'get', '/me/wishlist?sort=addedAt')).status).toBe(400);
  });

  it('only visible products can be added; one that becomes hidden stays, unavailable, and counts (WL-2)', async () => {
    const buyer = await api.customer();
    const product = await visibleProduct();
    expect((await call(buyer.token, 'put', `/me/wishlist/${product}`)).status).toBe(204);
    await knex()('products').where({ id: product }).update({ status: 'inactive' });

    const [item] = successBody<WishlistItem[]>(await call(buyer.token, 'get', '/me/wishlist')).data;
    expect(item?.product.available).toBe(false);
    const again = await call(buyer.token, 'put', `/me/wishlist/${product}`);
    expect(again.status).toBe(422);
    expect(errorBody(again).error.code).toBe('PRODUCT_NOT_FOUND');
    expect((await call(buyer.token, 'put', `/me/wishlist/${UNKNOWN_ID}`)).status).toBe(422);
    expect((await call(buyer.token, 'put', '/me/wishlist/not-a-uuid')).status).toBe(400);
  });

  it('WISHLIST_MAX_ITEMS holds under parallel adds; a product already there is fine at the limit', async () => {
    const buyer = await api.customer();
    const products = [];
    for (let i = 0; i < MAX_ITEMS + 3; i += 1) products.push(await visibleProduct());
    const results = await Promise.all(products.map((id) => call(buyer.token, 'put', `/me/wishlist/${id}`)));
    expect(results.filter((r) => r.status === 204)).toHaveLength(MAX_ITEMS);
    const refused = results.filter((r) => r.status === 422);
    expect(refused).toHaveLength(3);
    expect(refused.every((r) => errorBody(r).error.code === 'WISHLIST_LIMIT_REACHED')).toBe(true);
    expect(await knex()('wishlist_items').whereIn('product_id', products)).toHaveLength(MAX_ITEMS);

    const kept = (
      await knex()('wishlist_items')
        .whereIn('product_id', products)
        .first<{ product_id: string }>('product_id')
    )?.product_id;
    expect((await call(buyer.token, 'put', `/me/wishlist/${kept ?? ''}`)).status).toBe(204);
  });

  it('401 without a token, 403 for other roles', async () => {
    const product = await visibleProduct();
    expect((await request(t.app).get(`${API}/me/wishlist`)).status).toBe(401);
    const seller = await signTestAccessToken({ sub: UNKNOWN_ID, role: 'seller' });
    expect((await call(seller, 'put', `/me/wishlist/${product}`)).status).toBe(403);
  });
});
