import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CartDto } from '../../src/app/cart/dto/cart-response.dto';
import { cartFixtures } from '../helpers/cart-fixtures';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { startTestApp, type TestApp } from '../helpers/test-app';

const MAX_LINES = 5;
const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

/* Spec 08 over HTTP: happy path, validation, authz, not-found, live issues and the cart row lock. */
describe('cart endpoints', () => {
  let t: TestApp;
  let fx: ReturnType<typeof cartFixtures>;

  const knex = () => t.infra.db.knex;
  const as = (token: string | undefined) => {
    const auth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
    return {
      get: (path: string) => auth(request(t.app).get(`${API}${path}`)),
      post: (path: string, body?: object) => auth(request(t.app).post(`${API}${path}`)).send(body),
      patch: (path: string, body?: object) => auth(request(t.app).patch(`${API}${path}`)).send(body),
      delete: (path: string) => auth(request(t.app).delete(`${API}${path}`)),
    };
  };

  /** A customer profile and a token for it. */
  const customer = async () => {
    const { customerId, userId } = await fx.insertCustomer();
    return { customerId, token: await signTestAccessToken({ sub: userId, role: 'customer' }) };
  };

  /** An active, visible product with one active variant of `price` and `onHand` stock. */
  const listedVariant = async (
    options: { price?: string; onHand?: number; sellerId?: string } = {},
  ): Promise<{ variantId: string; productId: string; sellerId: string }> => {
    const price = options.price ?? '100.00';
    const sellerId = options.sellerId ?? (await fx.insertSeller()).sellerId;
    const categoryId = await fx.insertCategory();
    const productId = await fx.insertProduct(sellerId, categoryId, {
      status: 'active',
      published_at: new Date(),
      min_price: price,
      max_price: price,
      in_stock: (options.onHand ?? 10) > 0,
    });
    const variantId = await fx.insertVariant(productId, sellerId, { price });
    await knex()('inventory_items').insert({
      variant_id: variantId,
      on_hand: options.onHand ?? 10,
      reserved: 0,
    });
    return { variantId, productId, sellerId };
  };

  const cartOf = async (token: string): Promise<CartDto> => {
    const res = await as(token).get('/cart');
    expect(res.status).toBe(200);
    return successBody<CartDto>(res).data;
  };
  const add = (token: string, variantId: string, quantity: number) =>
    as(token).post('/cart/items', { variantId, quantity });
  const lineOf = (cart: CartDto, variantId: string) =>
    cart.sellers.flatMap((s) => s.items).find((item) => item.variantId === variantId);

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { CART_MAX_LINES: String(MAX_LINES) } });
    fx = cartFixtures(knex());
  });
  afterAll(async () => {
    await t.close();
  });

  describe('GET /cart', () => {
    it('a fresh account gets the empty shape, and no cart row is created', async () => {
      const { customerId, token } = await customer();
      expect(await cartOf(token)).toEqual({
        id: null,
        sellers: [],
        itemsTotal: '0.00',
        itemCount: 0,
        hasIssues: false,
      });
      expect(await knex()('carts').where({ customer_id: customerId }).select('id')).toEqual([]);
    });

    it('groups lines by seller with live prices and totals', async () => {
      const { token } = await customer();
      const a = await listedVariant({ price: '19.99' });
      const b = await listedVariant({ price: '250.00' });
      const a2 = await listedVariant({ price: '0.50', sellerId: a.sellerId });
      for (const [variantId, quantity] of [
        [a.variantId, 3],
        [b.variantId, 1],
        [a2.variantId, 2],
      ] as const) {
        expect((await add(token, variantId, quantity)).status).toBe(201);
      }

      const cart = await cartOf(token);
      expect(cart.id).toEqual(expect.any(String));
      expect(cart.sellers.map((s) => [s.sellerId, s.items.map((i) => i.variantId), s.subtotal])).toEqual([
        [a.sellerId, [a.variantId, a2.variantId], '60.97'],
        [b.sellerId, [b.variantId], '250.00'],
      ]);
      expect(cart.sellers[0]?.businessName).toMatch(/^Shop /);
      expect(lineOf(cart, a.variantId)).toMatchObject({
        productId: a.productId,
        unitPrice: '19.99',
        quantity: 3,
        lineTotal: '59.97',
        issue: null,
        availableQuantity: 10,
      });
      expect(cart).toMatchObject({ itemsTotal: '310.97', itemCount: 6, hasIssues: false });

      // Prices are read live, never stored.
      await knex()('product_variants').where({ id: b.variantId }).update({ price: '200.00' });
      expect(lineOf(await cartOf(token), b.variantId)?.unitPrice).toBe('200.00');
    });

    it('shows each issue after the matching catalog / inventory change and leaves it out of the totals', async () => {
      const { token } = await customer();
      const ok = await listedVariant({ price: '10.00' });
      const short = await listedVariant({ price: '10.00', onHand: 10 });
      const empty = await listedVariant({ price: '10.00', onHand: 10 });
      const hidden = await listedVariant({ price: '10.00' });
      const deleted = await listedVariant({ price: '10.00' });
      for (const v of [ok, short, empty, hidden, deleted])
        expect((await add(token, v.variantId, 4)).status).toBe(201);

      await knex()('inventory_items').where({ variant_id: short.variantId }).update({ on_hand: 2 });
      await knex()('inventory_items').where({ variant_id: empty.variantId }).update({ on_hand: 0 });
      // What the seller-suspension projection does (spec 06 UC-CA-7).
      await knex()('products').where({ id: hidden.productId }).update({ seller_active: false });
      await knex()('product_variants').where({ id: deleted.variantId }).update({ deleted_at: new Date() });

      const cart = await cartOf(token);
      expect(
        [ok, short, empty, hidden, deleted].map((v) => {
          const line = lineOf(cart, v.variantId);
          return [line?.issue, line?.availableQuantity];
        }),
      ).toEqual([
        [null, 10],
        ['INSUFFICIENT_STOCK', 2],
        ['OUT_OF_STOCK', 0],
        ['UNAVAILABLE', 0],
        ['UNAVAILABLE', 0],
      ]);
      expect(cart).toMatchObject({ itemsTotal: '40.00', itemCount: 4, hasIssues: true });

      // A deactivated product is unavailable too.
      await knex()('products').where({ id: ok.productId }).update({ status: 'inactive' });
      expect(lineOf(await cartOf(token), ok.variantId)?.issue).toBe('UNAVAILABLE');
    });
  });

  describe('POST /cart/items', () => {
    it('adding twice sums into one line; the sum over 99 is refused', async () => {
      const { token } = await customer();
      const v = await listedVariant({ onHand: 500 });
      expect((await add(token, v.variantId, 40)).status).toBe(201);
      const res = await add(token, v.variantId, 50);
      expect(res.status).toBe(201);
      const cart = successBody<CartDto>(res).data;
      expect(cart.sellers.flatMap((s) => s.items).map((i) => i.quantity)).toEqual([90]);

      const over = await add(token, v.variantId, 10);
      expect(over.status).toBe(422);
      expect(errorBody(over).error.code).toBe('CART_ITEM_QUANTITY_LIMIT');
      expect(lineOf(await cartOf(token), v.variantId)?.quantity).toBe(90);
    });

    it('a quantity over sellable is 409 INSUFFICIENT_STOCK with the details shape', async () => {
      const { token } = await customer();
      const v = await listedVariant({ onHand: 3 });
      const res = await add(token, v.variantId, 4);
      expect(res.status).toBe(409);
      expect(errorBody(res).error).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        details: [
          { field: 'variantId', value: v.variantId, constraint: 'available', message: 'available: 3' },
        ],
      });
    });

    it('unknown, inactive, deleted and hidden-seller variants are 422 VARIANT_NOT_PURCHASABLE', async () => {
      const { token } = await customer();
      const inactive = await listedVariant();
      await knex()('product_variants').where({ id: inactive.variantId }).update({ status: 'inactive' });
      const deleted = await listedVariant();
      await knex()('product_variants').where({ id: deleted.variantId }).update({ deleted_at: new Date() });
      const hidden = await listedVariant();
      await knex()('products').where({ id: hidden.productId }).update({ seller_active: false });
      for (const variantId of [UNKNOWN_ID, inactive.variantId, deleted.variantId, hidden.variantId]) {
        const res = await add(token, variantId, 1);
        expect(res.status).toBe(422);
        expect(errorBody(res).error.code).toBe('VARIANT_NOT_PURCHASABLE');
      }
    });

    it(`a new line beyond CART_MAX_LINES (${MAX_LINES}) is refused; adding to an existing line still works`, async () => {
      const { token } = await customer();
      const variants = [];
      for (let i = 0; i < MAX_LINES; i += 1) variants.push(await listedVariant());
      for (const v of variants) expect((await add(token, v.variantId, 1)).status).toBe(201);
      const extra = await listedVariant();
      const res = await add(token, extra.variantId, 1);
      expect(res.status).toBe(422);
      expect(errorBody(res).error.code).toBe('CART_LINE_LIMIT_REACHED');
      expect((await add(token, variants[0]?.variantId ?? '', 1)).status).toBe(201);
    });

    it.each([
      [{ quantity: 1 }],
      [{ variantId: 'not-a-uuid', quantity: 1 }],
      [{ variantId: UNKNOWN_ID, quantity: 0 }],
      [{ variantId: UNKNOWN_ID, quantity: 100 }],
      [{ variantId: UNKNOWN_ID, quantity: 1.5 }],
      [{ variantId: UNKNOWN_ID, quantity: '2' }],
      [{ variantId: UNKNOWN_ID, quantity: 1, price: '1.00' }],
    ])('rejects %j with 400', async (body) => {
      const { token } = await customer();
      const res = await as(token).post('/cart/items', body);
      expect(res.status).toBe(400);
      expect(errorBody(res).error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PATCH and DELETE /cart/items/:itemId', () => {
    const lineIdOf = async (token: string, variantId: string): Promise<string> => {
      const id = lineOf(await cartOf(token), variantId)?.id;
      if (!id) throw new Error('line not found');
      return id;
    };

    it('sets the quantity; over sellable is 409; an unavailable line can only be removed', async () => {
      const { token } = await customer();
      const v = await listedVariant({ onHand: 5 });
      await add(token, v.variantId, 1);
      const itemId = await lineIdOf(token, v.variantId);

      const res = await as(token).patch(`/cart/items/${itemId}`, { quantity: 5 });
      expect(res.status).toBe(200);
      expect(lineOf(successBody<CartDto>(res).data, v.variantId)?.quantity).toBe(5);
      expect((await as(token).patch(`/cart/items/${itemId}`, { quantity: 6 })).status).toBe(409);

      await knex()('product_variants').where({ id: v.variantId }).update({ status: 'inactive' });
      const decrease = await as(token).patch(`/cart/items/${itemId}`, { quantity: 1 });
      expect(decrease.status).toBe(422);
      expect(errorBody(decrease).error.code).toBe('VARIANT_NOT_PURCHASABLE');

      expect((await as(token).delete(`/cart/items/${itemId}`)).status).toBe(204);
      expect((await cartOf(token)).sellers).toEqual([]);
    });

    it('another customer’s line, an unknown line, and no cart at all are 404', async () => {
      const owner = await customer();
      const other = await customer();
      const v = await listedVariant();
      await add(owner.token, v.variantId, 1);
      const itemId = await lineIdOf(owner.token, v.variantId);

      for (const [token, id] of [
        [other.token, itemId],
        [owner.token, UNKNOWN_ID],
      ] as const) {
        const patched = await as(token).patch(`/cart/items/${id}`, { quantity: 2 });
        expect(patched.status).toBe(404);
        expect(errorBody(patched).error.code).toBe('CART_ITEM_NOT_FOUND');
        expect((await as(token).delete(`/cart/items/${id}`)).status).toBe(404);
      }
      expect(lineOf(await cartOf(owner.token), v.variantId)?.quantity).toBe(1);
    });

    it('validates the id and the body', async () => {
      const { token } = await customer();
      expect((await as(token).patch('/cart/items/not-a-uuid', { quantity: 1 })).status).toBe(400);
      expect((await as(token).patch(`/cart/items/${UNKNOWN_ID}`, { quantity: 0 })).status).toBe(400);
      expect((await as(token).patch(`/cart/items/${UNKNOWN_ID}`, {})).status).toBe(400);
      expect((await as(token).delete('/cart/items/not-a-uuid')).status).toBe(400);
    });
  });

  describe('DELETE /cart', () => {
    it('empties the cart, and is a 204 with no cart', async () => {
      const { customerId, token } = await customer();
      expect((await as(token).delete('/cart')).status).toBe(204);
      expect(await knex()('carts').where({ customer_id: customerId }).select('id')).toEqual([]);

      await add(token, (await listedVariant()).variantId, 1);
      await add(token, (await listedVariant()).variantId, 1);
      expect((await as(token).delete('/cart')).status).toBe(204);
      const cart = await cartOf(token);
      expect(cart.sellers).toEqual([]);
      expect(cart.id).toEqual(expect.any(String));
    });
  });

  describe('authz', () => {
    it('anonymous is 401; seller and admin tokens are 403', async () => {
      const seller = await signTestAccessToken({ role: 'seller' });
      const admin = await signTestAccessToken({ role: 'admin' });
      const calls = [
        (token?: string) => as(token).get('/cart'),
        (token?: string) => as(token).post('/cart/items', { variantId: UNKNOWN_ID, quantity: 1 }),
        (token?: string) => as(token).patch(`/cart/items/${UNKNOWN_ID}`, { quantity: 1 }),
        (token?: string) => as(token).delete(`/cart/items/${UNKNOWN_ID}`),
        (token?: string) => as(token).delete('/cart'),
      ];
      for (const call of calls) {
        expect((await call(undefined)).status).toBe(401);
        expect((await call(seller)).status).toBe(403);
        expect((await call(admin)).status).toBe(403);
      }
    });

    it('a customer token without a customer profile is an internal error (CT-8)', async () => {
      const orphan = await signTestAccessToken({ role: 'customer' });
      const res = await as(orphan).get('/cart');
      expect(res.status).toBe(500);
      expect(errorBody(res).error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('concurrency (cart row lock, CT-2)', () => {
    it('parallel adds of different variants into a cart one line short of the limit end with exactly the limit', async () => {
      const { token } = await customer();
      for (let i = 0; i < MAX_LINES - 1; i += 1) await add(token, (await listedVariant()).variantId, 1);
      const racers = await Promise.all([listedVariant(), listedVariant(), listedVariant()]);
      const statuses = (await Promise.all(racers.map((v) => add(token, v.variantId, 1)))).map(
        (r) => r.status,
      );
      expect(statuses.sort()).toEqual([201, 422, 422]);
      expect((await cartOf(token)).sellers.flatMap((s) => s.items)).toHaveLength(MAX_LINES);
    });

    it('parallel adds of the same variant end with one line and the right sum', async () => {
      const { token } = await customer();
      const v = await listedVariant({ onHand: 99 });
      const statuses = await Promise.all(Array.from({ length: 6 }, () => add(token, v.variantId, 3)));
      expect(statuses.map((r) => r.status)).toEqual(Array(6).fill(201));
      const lines = (await cartOf(token)).sellers.flatMap((s) => s.items);
      expect(lines.map((l) => l.quantity)).toEqual([18]);
    });

    it('two parallel first adds create one cart', async () => {
      const { customerId, token } = await customer();
      const [a, b] = await Promise.all([listedVariant(), listedVariant()]);
      const statuses = await Promise.all([add(token, a.variantId, 1), add(token, b.variantId, 1)]);
      expect(statuses.map((r) => r.status)).toEqual([201, 201]);
      expect(await knex()('carts').where({ customer_id: customerId }).select('id')).toHaveLength(1);
      expect((await cartOf(token)).sellers.flatMap((s) => s.items)).toHaveLength(2);
    });
  });
});
