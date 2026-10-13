import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AdminAttributeDto,
  type AdminCategoryNodeDto,
} from '../../src/app/catalog/dto/category-response.dto';
import {
  type SellerProductDetailDto,
  type SellerProductDto,
  type SellerVariantDto,
  type StockMovementDto,
  type VariantStockDto,
} from '../../src/app/catalog/dto/product-response.dto';
import { catalogFixtures } from '../helpers/catalog-fixtures';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { sellerFixtures } from '../helpers/sellers';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '01920d3e-7a1c-7c2b-9a4e-3f0c2d1b6a55';

describe('catalog: seller products, variants, stock (spec 06 §4.3)', () => {
  let t: TestApp;
  let adminToken: string;
  let seller: { token: string; sellerId: string; userId: string };
  let otherSeller: { token: string; sellerId: string };
  let pendingToken: string;
  let customerToken: string;
  /** Category without attributes: one default variant. */
  let flatCategoryId: string;
  /** Category with size (s, m, xl) and color (red, blue). */
  let sized: { id: string; options: Record<string, string> };

  const as = (token: string | null) => {
    const auth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
    return {
      get: (path: string) => auth(request(t.app).get(`${API}${path}`)),
      post: (path: string, body?: object, headers: Record<string, string> = {}) =>
        auth(request(t.app).post(`${API}${path}`))
          .set(headers)
          .send(body),
      patch: (path: string, body?: object) => auth(request(t.app).patch(`${API}${path}`)).send(body),
      delete: (path: string) => auth(request(t.app).delete(`${API}${path}`)),
    };
  };
  const me = () => as(seller.token);
  const code = (res: request.Response) => errorBody(res).error.code;
  const knex = () => t.infra.db.knex;

  const createProduct = async (categoryId = flatCategoryId, token = seller.token) => {
    const res = await as(token).post('/seller/products', {
      categoryId,
      name: 'Smart Phone X',
      description: 'Fast',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return successBody<SellerProductDetailDto>(res).data;
  };
  const variantBody = (overrides: Record<string, unknown> = {}) => ({
    sku: `SKU-${randomUUID().slice(0, 8)}`,
    price: '100.00',
    optionIds: [],
    initialStock: 5,
    status: 'active',
    ...overrides,
  });
  const addVariant = (productId: string, overrides: Record<string, unknown> = {}, token = seller.token) =>
    as(token).post(`/seller/products/${productId}/variants`, variantBody(overrides));
  const detail = async (productId: string) =>
    successBody<SellerProductDetailDto>(await me().get(`/seller/products/${productId}`)).data;
  const adjust = (variantId: string, delta: unknown, key: string = randomUUID()) =>
    me().post(`/seller/variants/${variantId}/stock-adjustments`, { delta }, { 'Idempotency-Key': key });

  const approvedSeller = async () => {
    const fx = sellerFixtures(t);
    const created = await fx.createVerifiedSeller();
    const approve = await as(adminToken).post(`/admin/sellers/${created.sellerId}/approve`);
    expect(approve.status).toBe(200);
    return { token: created.accessToken, sellerId: created.sellerId, userId: created.userId };
  };
  const adminCategory = async (body: Record<string, unknown> = {}) =>
    successBody<AdminCategoryNodeDto>(
      await as(adminToken).post('/admin/categories', {
        name: `Cat ${randomUUID().slice(0, 8)}`,
        sortOrder: 0,
        ...body,
      }),
    ).data;

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '10000' } });
    const fx = sellerFixtures(t);
    adminToken = (await fx.createActiveAdmin()).session.accessToken;
    customerToken = (await fx.createActiveCustomer()).accessToken;
    seller = await approvedSeller();
    otherSeller = await approvedSeller();
    pendingToken = (await fx.createVerifiedSeller()).accessToken;

    flatCategoryId = (await adminCategory()).id;
    const category = await adminCategory();
    const options: Record<string, string> = {};
    for (const [attributeCode, codes] of [
      ['size', ['s', 'm', 'xl']],
      ['color', ['red', 'blue']],
    ] as const) {
      const attribute = successBody<AdminAttributeDto>(
        await as(adminToken).post(`/admin/categories/${category.id}/attributes`, {
          name: attributeCode,
          code: attributeCode,
          sortOrder: attributeCode === 'size' ? 0 : 1,
        }),
      ).data;
      for (const optionCode of codes) {
        const res = await as(adminToken).post(`/admin/attributes/${attribute.id}/options`, {
          value: optionCode.toUpperCase(),
          code: optionCode,
          sortOrder: 0,
        });
        options[optionCode] = successBody<{ id: string }>(res).data.id;
      }
    }
    sized = { id: category.id, options };
  });
  afterAll(async () => {
    await t.close();
  });

  describe('authorization', () => {
    it('401 anonymous, 403 for a customer, on every seller route', async () => {
      for (const token of [null, customerToken]) {
        const status = token ? 403 : 401;
        expect((await as(token).get('/seller/products')).status).toBe(status);
        expect((await as(token).post('/seller/products', {})).status).toBe(status);
        expect((await as(token).get(`/seller/products/${UNKNOWN_ID}`)).status).toBe(status);
        expect((await as(token).post(`/seller/products/${UNKNOWN_ID}/variants`, {})).status).toBe(status);
        expect((await as(token).post(`/seller/variants/${UNKNOWN_ID}/stock-adjustments`, {})).status).toBe(
          status,
        );
        expect((await as(token).get(`/seller/variants/${UNKNOWN_ID}/stock-movements`)).status).toBe(status);
      }
    });

    it('a seller who is not approved can read but not write (S-17)', async () => {
      const list = await as(pendingToken).get('/seller/products');
      expect([list.status, successBody<unknown[]>(list).data]).toEqual([200, []]);
      const create = await as(pendingToken).post('/seller/products', {
        categoryId: flatCategoryId,
        name: 'Phone',
        description: 'x',
      });
      expect([create.status, code(create)]).toEqual([403, 'SELLER_NOT_APPROVED']);
    });

    it("another seller's product and variants are not found (IDOR)", async () => {
      const product = await createProduct();
      const variant = successBody<SellerVariantDto>(await addVariant(product.id)).data;
      const other = as(otherSeller.token);
      expect(code(await other.get(`/seller/products/${product.id}`))).toBe('PRODUCT_NOT_FOUND');
      expect(code(await other.patch(`/seller/products/${product.id}`, { name: 'Mine' }))).toBe(
        'PRODUCT_NOT_FOUND',
      );
      expect(code(await other.delete(`/seller/products/${product.id}`))).toBe('PRODUCT_NOT_FOUND');
      expect(code(await addVariant(product.id, {}, otherSeller.token))).toBe('PRODUCT_NOT_FOUND');
      const stock = await other
        .post(`/seller/variants/${variant.id}/stock-adjustments`, { delta: 1 })
        .set('Idempotency-Key', randomUUID());
      expect(code(stock)).toBe('VARIANT_NOT_FOUND');
      expect(code(await other.get(`/seller/variants/${variant.id}/stock-movements`))).toBe(
        'VARIANT_NOT_FOUND',
      );
    });
  });

  describe('products', () => {
    it('creates a draft with an immutable random-suffix slug', async () => {
      const product = await createProduct();
      expect(product).toMatchObject({
        name: 'Smart Phone X',
        description: 'Fast',
        categoryId: flatCategoryId,
        status: 'draft',
        visible: false,
        minPrice: null,
        maxPrice: null,
        inStock: false,
        publishedAt: null,
        variants: [],
      });
      expect(product.slug).toMatch(/^smart-phone-x-[0-9a-z]{6}$/);
      const renamed = await me().patch(`/seller/products/${product.id}`, { name: 'Renamed' });
      expect(successBody<SellerProductDetailDto>(renamed).data).toMatchObject({
        name: 'Renamed',
        slug: product.slug,
      });
    });

    it('validates bodies strictly; the category must exist and be active (422)', async () => {
      for (const body of [
        {},
        { categoryId: flatCategoryId, name: 'X', description: 'd' },
        { categoryId: flatCategoryId, name: 'Phone', description: '' },
        { categoryId: 'nope', name: 'Phone', description: 'd' },
        { categoryId: flatCategoryId, name: 'Phone', description: 'd', status: 'active' },
      ]) {
        const res = await me().post('/seller/products', body);
        expect([res.status, code(res)], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
      }
      const unknown = await me().post('/seller/products', {
        categoryId: UNKNOWN_ID,
        name: 'Phone',
        description: 'd',
      });
      expect([unknown.status, code(unknown)]).toEqual([422, 'CATEGORY_NOT_FOUND']);
      const inactive = await adminCategory();
      await as(adminToken).patch(`/admin/categories/${inactive.id}`, { isActive: false });
      expect(
        code(
          await me().post('/seller/products', { categoryId: inactive.id, name: 'Phone', description: 'd' }),
        ),
      ).toBe('CATEGORY_NOT_FOUND');
      expect((await me().patch(`/seller/products/${UNKNOWN_ID}`, {})).status).toBe(400);
      expect(code(await me().get(`/seller/products/${UNKNOWN_ID}`))).toBe('PRODUCT_NOT_FOUND');
    });

    it('the category can change only while the product has no variants', async () => {
      const product = await createProduct();
      const other = await adminCategory();
      expect((await me().patch(`/seller/products/${product.id}`, { categoryId: other.id })).status).toBe(200);
      await addVariant(product.id);
      const locked = await me().patch(`/seller/products/${product.id}`, { categoryId: flatCategoryId });
      expect([locked.status, code(locked)]).toEqual([409, 'PRODUCT_CATEGORY_LOCKED']);
    });

    it('activate needs an active variant and sets publishedAt once; draft → active ⇄ inactive', async () => {
      const product = await createProduct();
      const noVariant = await me().post(`/seller/products/${product.id}/activate`);
      expect([noVariant.status, code(noVariant)]).toEqual([409, 'PRODUCT_HAS_NO_ACTIVE_VARIANT']);
      expect(code(await me().post(`/seller/products/${product.id}/deactivate`))).toBe(
        'PRODUCT_INVALID_STATUS_TRANSITION',
      );

      await addVariant(product.id);
      const active = successBody<SellerProductDetailDto>(
        await me().post(`/seller/products/${product.id}/activate`),
      ).data;
      expect(active).toMatchObject({ status: 'active', visible: true });
      expect(active.publishedAt).not.toBeNull();
      expect(code(await me().post(`/seller/products/${product.id}/activate`))).toBe(
        'PRODUCT_INVALID_STATUS_TRANSITION',
      );

      expect(
        successBody<SellerProductDetailDto>(await me().post(`/seller/products/${product.id}/deactivate`)).data
          .status,
      ).toBe('inactive');
      const again = successBody<SellerProductDetailDto>(
        await me().post(`/seller/products/${product.id}/activate`),
      ).data;
      expect(again.publishedAt).toBe(active.publishedAt);
    });

    it('delete soft-deletes the product and its variants', async () => {
      const product = await createProduct();
      await addVariant(product.id);
      expect((await me().delete(`/seller/products/${product.id}`)).status).toBe(204);
      expect(code(await me().get(`/seller/products/${product.id}`))).toBe('PRODUCT_NOT_FOUND');
      const variants = await knex()('product_variants')
        .where({ product_id: product.id })
        .select('deleted_at');
      expect(variants.every((v: { deleted_at: Date | null }) => v.deleted_at !== null)).toBe(true);
    });

    it('lists my live products with filters and cursor pagination', async () => {
      const mine = as((await approvedSeller()).token);
      const ids: string[] = [];
      for (const name of ['Alpha lamp', 'Beta lamp', 'Gamma chair']) {
        const res = await mine.post('/seller/products', {
          categoryId: flatCategoryId,
          name,
          description: 'd',
        });
        ids.push(successBody<SellerProductDto>(res).data.id);
      }
      await mine.delete(`/seller/products/${ids[2] ?? ''}`);
      const lamps = successBody<SellerProductDto[]>(await mine.get('/seller/products?name[like]=lamp')).data;
      expect(lamps.map((p) => p.name)).toEqual(['Beta lamp', 'Alpha lamp']);

      const first = await mine.get('/seller/products?limit=1');
      const page1 = successBody<SellerProductDto[]>(first);
      expect(page1.meta).toMatchObject({ hasMore: true, limit: 1 });
      const second = await mine.get(`/seller/products?limit=1&cursor=${page1.meta?.nextCursor ?? ''}`);
      expect(successBody<SellerProductDto[]>(second).data.map((p) => p.name)).toEqual(['Alpha lamp']);
      expect((await mine.get('/seller/products?status[in]=draft,bogus')).status).toBe(400);
    });
  });

  describe('variants', () => {
    it('a category without attributes gets exactly one default variant', async () => {
      const product = await createProduct();
      const res = await addVariant(product.id, { initialStock: 7 });
      expect(res.status).toBe(201);
      expect(successBody<SellerVariantDto>(res).data).toMatchObject({
        isDefault: true,
        options: [],
        stock: { onHand: 7, reserved: 0, sellable: 7 },
        compareAtPrice: null,
      });
      expect(code(await addVariant(product.id))).toBe('DEFAULT_VARIANT_EXISTS');
    });

    it('needs exactly one option per attribute; a combination exists once', async () => {
      const product = await createProduct(sized.id);
      const { s, xl, red, blue } = sized.options as Record<'s' | 'xl' | 'red' | 'blue', string>;
      const missing = await addVariant(product.id, { optionIds: [xl] });
      expect([missing.status, code(missing)]).toEqual([422, 'VARIANT_OPTIONS_INVALID']);
      expect(errorBody(missing).error.details).toEqual([
        expect.objectContaining({ constraint: 'missing', value: 'color' }),
      ]);
      expect(code(await addVariant(product.id, { optionIds: [xl, s, red] }))).toBe('VARIANT_OPTIONS_INVALID');
      expect(code(await addVariant(product.id, { optionIds: [xl, UNKNOWN_ID] }))).toBe(
        'VARIANT_OPTIONS_INVALID',
      );

      const created = await addVariant(product.id, { optionIds: [red, xl] });
      expect(created.status).toBe(201);
      expect(
        successBody<SellerVariantDto>(created).data.options.map((o) => [
          o.attributeCode,
          o.optionCode,
          o.value,
        ]),
      ).toEqual([
        ['size', 'xl', 'XL'],
        ['color', 'red', 'RED'],
      ]);
      const dup = await addVariant(product.id, { optionIds: [xl, red] });
      expect([dup.status, code(dup)]).toEqual([409, 'VARIANT_COMBINATION_EXISTS']);
      expect((await addVariant(product.id, { optionIds: [xl, blue] })).status).toBe(201);
    });

    it('SKUs are unique per seller case-insensitively; prices are validated', async () => {
      const product = await createProduct(sized.id);
      const { m, red, blue } = sized.options as Record<'m' | 'red' | 'blue', string>;
      const sku = `ABC-${randomUUID().slice(0, 6)}`;
      expect((await addVariant(product.id, { sku, optionIds: [m, red] })).status).toBe(201);
      const taken = await addVariant(product.id, { sku: sku.toLowerCase(), optionIds: [m, blue] });
      expect([taken.status, code(taken)]).toEqual([409, 'SKU_TAKEN']);
      const otherProduct = await createProduct(flatCategoryId, otherSeller.token);
      expect((await addVariant(otherProduct.id, { sku }, otherSeller.token)).status).toBe(201);

      expect(code(await addVariant(product.id, { optionIds: [m, blue], price: '0' }))).toBe(
        'VALIDATION_FAILED',
      );
      expect(code(await addVariant(product.id, { optionIds: [m, blue], price: '10.001' }))).toBe(
        'VALIDATION_FAILED',
      );
      expect(code(await addVariant(product.id, { optionIds: [m, blue], sku: 'bad sku' }))).toBe(
        'VALIDATION_FAILED',
      );
      const compare = await addVariant(product.id, {
        optionIds: [m, blue],
        price: '50.00',
        compareAtPrice: '50',
      });
      expect([compare.status, code(compare)]).toEqual([422, 'COMPARE_AT_PRICE_INVALID']);
    });

    it('keeps min/max price and in-stock right after create, update and delete', async () => {
      const product = await createProduct(sized.id);
      const { s, m, red } = sized.options as Record<'s' | 'm' | 'red', string>;
      await addVariant(product.id, { optionIds: [s, red], price: '120.00', initialStock: 0 });
      expect(await detail(product.id)).toMatchObject({
        minPrice: '120.00',
        maxPrice: '120.00',
        inStock: false,
      });
      const b = successBody<SellerVariantDto>(
        await addVariant(product.id, { optionIds: [m, red], price: '80.50', initialStock: 2 }),
      ).data;
      expect(await detail(product.id)).toMatchObject({
        minPrice: '80.50',
        maxPrice: '120.00',
        inStock: true,
      });

      const updated = await me().patch(`/seller/products/${product.id}/variants/${b.id}`, {
        price: '200.00',
        compareAtPrice: '250.00',
      });
      expect(successBody<SellerVariantDto>(updated).data).toMatchObject({
        price: '200.00',
        compareAtPrice: '250.00',
      });
      expect(await detail(product.id)).toMatchObject({ minPrice: '120.00', maxPrice: '200.00' });
      const badCompare = await me().patch(`/seller/products/${product.id}/variants/${b.id}`, {
        price: '300.00',
      });
      expect(code(badCompare)).toBe('COMPARE_AT_PRICE_INVALID');

      expect((await me().delete(`/seller/products/${product.id}/variants/${b.id}`)).status).toBe(204);
      expect(await detail(product.id)).toMatchObject({
        minPrice: '120.00',
        maxPrice: '120.00',
        inStock: false,
      });
      expect(
        code(await me().patch(`/seller/products/${product.id}/variants/${b.id}`, { price: '1.00' })),
      ).toBe('VARIANT_NOT_FOUND');
    });

    it('deactivating the last active variant moves an active product to inactive', async () => {
      const product = await createProduct();
      const variant = successBody<SellerVariantDto>(await addVariant(product.id)).data;
      await me().post(`/seller/products/${product.id}/activate`);
      await me().patch(`/seller/products/${product.id}/variants/${variant.id}`, { status: 'inactive' });
      expect(await detail(product.id)).toMatchObject({ status: 'inactive', minPrice: null, visible: false });
    });

    it('parallel creates respect the single default variant and the 100-variant limit', async () => {
      const flat = await createProduct();
      const results = await Promise.all(Array.from({ length: 5 }, () => addVariant(flat.id)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);

      const product = await createProduct(sized.id);
      const fx = catalogFixtures(knex());
      for (let i = 0; i < 99; i += 1) await fx.insertVariant(product.id, seller.sellerId);
      const { s, m, red } = sized.options as Record<'s' | 'm' | 'red', string>;
      const racing = await Promise.all([
        addVariant(product.id, { optionIds: [s, red] }),
        addVariant(product.id, { optionIds: [m, red] }),
      ]);
      expect(racing.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(racing.map((r) => (r.status === 422 ? code(r) : null))).toContain('VARIANT_LIMIT_REACHED');
    });
  });

  describe('stock (S-6)', () => {
    const variantWithStock = async (initialStock: number) => {
      const product = await createProduct();
      const variant = successBody<SellerVariantDto>(await addVariant(product.id, { initialStock })).data;
      return { productId: product.id, variant };
    };

    it('needs an Idempotency-Key; replays the result; refuses a reused key with another payload', async () => {
      const { productId, variant } = await variantWithStock(5);
      const noKey = await me().post(`/seller/variants/${variant.id}/stock-adjustments`, { delta: 1 });
      expect([noKey.status, code(noKey)]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);

      const key = randomUUID();
      const first = await adjust(variant.id, 3, key);
      expect(successBody<VariantStockDto>(first).data).toEqual({
        variantId: variant.id,
        onHand: 8,
        reserved: 0,
        sellable: 8,
      });
      const replay = await adjust(variant.id, 3, key);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(code(await adjust(variant.id, 4, key))).toBe('IDEMPOTENCY_KEY_REUSED');
      // The replay did not apply the delta twice.
      expect((await detail(productId)).variants[0]?.stock.onHand).toBe(8);
    });

    it('refuses a delta of 0 or one that would go below 0, and records movements', async () => {
      const { variant } = await variantWithStock(2);
      expect(code(await adjust(variant.id, 0))).toBe('VALIDATION_FAILED');
      expect(code(await adjust(variant.id, '1'))).toBe('VALIDATION_FAILED');
      const below = await adjust(variant.id, -3);
      expect([below.status, code(below)]).toEqual([422, 'STOCK_ADJUSTMENT_INVALID']);
      expect((await adjust(variant.id, -2)).status).toBe(200);
      expect(code(await adjust(UNKNOWN_ID, 1))).toBe('VARIANT_NOT_FOUND');

      const movements = successBody<StockMovementDto[]>(
        await me().get(`/seller/variants/${variant.id}/stock-movements`),
      );
      expect(movements.data.map((m) => [m.type, m.quantityDelta, m.onHandAfter])).toEqual([
        ['seller_adjustment', -2, 0],
        ['seller_adjustment', 2, 2],
      ]);
      const outbox = await knex()('events_outbox')
        .where({ event_type: 'inventory.stock_status_changed' })
        .whereRaw(`payload->>'variantId' = ?`, [variant.id])
        .select<{ payload: { inStock: boolean } }[]>('payload');
      expect(outbox.map((row) => row.payload.inStock)).toEqual([false]);
    });

    it('a suspended seller cannot adjust stock, but can still read the history', async () => {
      const suspended = await approvedSeller();
      const product = await createProduct(flatCategoryId, suspended.token);
      const variant = successBody<SellerVariantDto>(await addVariant(product.id, {}, suspended.token)).data;
      await as(adminToken).post(`/admin/sellers/${suspended.sellerId}/suspend`, { reason: 'Checks' });
      const res = await as(suspended.token)
        .post(`/seller/variants/${variant.id}/stock-adjustments`, { delta: 1 })
        .set('Idempotency-Key', randomUUID());
      expect([res.status, code(res)]).toEqual([403, 'SELLER_NOT_APPROVED']);
      expect((await as(suspended.token).get(`/seller/variants/${variant.id}/stock-movements`)).status).toBe(
        200,
      );
    });
  });

  it('a product write waits for a suspension in progress and then sees it (P3-Q4)', async () => {
    const racing = await approvedSeller();
    const trx = await knex().transaction();
    // What the suspension does first: it holds the seller row while it commits the new status.
    await trx('sellers')
      .where({ id: racing.sellerId })
      .update({ status: 'suspended', updated_at: trx.fn.now() });
    const pending = as(racing.token)
      .post('/seller/products', { categoryId: flatCategoryId, name: 'Racing', description: 'd' })
      .then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await trx.commit();
    const res = await pending;
    expect([res.status, code(res)]).toEqual([403, 'SELLER_NOT_APPROVED']);
    expect(await knex()('products').where({ seller_id: racing.sellerId })).toEqual([]);
  });
});
