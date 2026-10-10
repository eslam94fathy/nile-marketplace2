import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ICatalogDirectory } from '../../src/app/catalog';
import { productDetailCacheKey } from '../../src/app/catalog/constants';
import { type ProductDetailDto, type ProductListItemDto } from '../../src/app/catalog/dto/product-public.dto';
import { TOKENS } from '../../src/lib/di';
import { catalogApi } from '../helpers/catalog-api';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { sellerFixtures } from '../helpers/sellers';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '01920d3e-7a1c-7c2b-9a4e-3f0c2d1b6a55';

describe('catalog: public browse, search, detail (spec 06 §4.1, UC-CA-6)', () => {
  let t: TestApp;
  let api: ReturnType<typeof catalogApi>;
  let seller: { token: string; sellerId: string };
  let other: { token: string; sellerId: string };
  /** root (color) → child (size); flat has no attributes. */
  let root: string;
  let child: string;
  let flat: string;
  let color: Record<string, string>;
  let size: Record<string, string>;
  let headphones: { id: string; slug: string; variants: { id: string }[] };
  let simple: { id: string; slug: string; variants: { id: string }[] };
  let draft: { id: string; slug: string; variants: { id: string }[] };

  const get = (path: string) => request(t.app).get(`${API}${path}`);
  const list = async (query: string) => {
    const res = await get(`/products?${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return successBody<ProductListItemDto[]>(res);
  };
  const names = async (query: string) => (await list(query)).data.map((p) => p.name);
  const code = (res: request.Response) => errorBody(res).error.code;

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '10000' } });
    const fx = sellerFixtures(t);
    api = catalogApi(t, (await fx.createActiveAdmin()).session.accessToken);
    seller = await api.approvedSeller();
    other = await api.approvedSeller();

    root = (await api.category({ name: `Electronics ${randomUUID().slice(0, 6)}` })).id;
    child = (await api.category({ parentId: root, name: 'Audio' })).id;
    flat = (await api.category({ name: `Accessories ${randomUUID().slice(0, 6)}` })).id;
    color = await api.attribute(root, 'color', ['red', 'blue']);
    size = await api.attribute(child, 'size', ['s', 'xl']);

    // Published in this order, so "newest first" is the reverse.
    headphones = await api.product(seller.token, child, 'Wireless Headphones', [
      { optionIds: [size.xl ?? '', color.blue ?? ''], price: '150.00', stock: 3 },
      { optionIds: [size.s ?? '', color.red ?? ''], price: '99.00', stock: 0 },
    ]);
    await api.product(seller.token, child, 'Studio Speaker', [
      { optionIds: [size.xl ?? '', color.red ?? ''], price: '300.00', stock: 0 },
    ]);
    simple = await api.product(other.token, flat, 'Headphones', [{ price: '20.00', stock: 150 }]);
    draft = await api.product(seller.token, flat, 'Hidden Draft Headphones', [{ price: '5.00', stock: 1 }], {
      activate: false,
    });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('GET /products', () => {
    it('lists visible products newest first, with category and seller', async () => {
      const page = await list(`sellerId[eq]=${seller.sellerId}`);
      expect(page.data.map((p) => p.name)).toEqual(['Studio Speaker', 'Wireless Headphones']);
      expect(page.data[1]).toMatchObject({
        id: headphones.id,
        slug: headphones.slug,
        minPrice: '99.00',
        maxPrice: '150.00',
        inStock: true,
        category: { id: child, name: 'Audio' },
        seller: { id: seller.sellerId },
      });
      expect(page.data[1]?.seller.businessName).toMatch(/^Shop /);
    });

    it('categoryId includes descendants; price uses the lowest variant price; inStock and sellerId filter', async () => {
      expect(await names(`categoryId[eq]=${root}`)).toEqual(['Studio Speaker', 'Wireless Headphones']);
      expect(await names(`categoryId[eq]=${child}&price[lte]=100`)).toEqual(['Wireless Headphones']);
      expect(await names(`categoryId[eq]=${child}&inStock[eq]=false`)).toEqual(['Studio Speaker']);
      expect(await names(`categoryId[eq]=${UNKNOWN_ID}`)).toEqual([]);
      expect(await names(`sellerId[eq]=${other.sellerId}`)).toEqual(['Headphones']);
    });

    it('attr.* filters must all match the same active variant (CA-5)', async () => {
      const both = `categoryId[eq]=${child}&attr.size[in]=xl&attr.color[in]=red`;
      // Wireless Headphones has xl-blue and s-red, but no xl-red variant.
      expect(await names(both)).toEqual(['Studio Speaker']);
      expect(await names(`categoryId[eq]=${child}&attr.size[in]=xl`)).toEqual([
        'Studio Speaker',
        'Wireless Headphones',
      ]);
      // From the root, the descendant's size attribute resolves too.
      expect(await names(`categoryId[eq]=${root}&attr.size[in]=s`)).toEqual(['Wireless Headphones']);
      expect(await names(`categoryId[eq]=${root}&attr.color[in]=blue,red`)).toHaveLength(2);
    });

    it('rejects attr.* without categoryId, unknown codes, and bad values', async () => {
      const bad = async (query: string) => {
        const res = await get(`/products?${query}`);
        expect(res.status, query).toBe(400);
        return code(res);
      };
      expect(await bad('attr.size[in]=xl')).toBe('INVALID_QUERY');
      expect(await bad(`categoryId[eq]=${child}&attr.weight[in]=x`)).toBe('INVALID_QUERY');
      expect(await bad(`categoryId[eq]=${child}&attr.size[in]=huge`)).toBe('INVALID_QUERY');
      expect(await bad(`categoryId[eq]=${flat}&attr.size[in]=xl`)).toBe('INVALID_QUERY');
      expect(await bad(`categoryId[eq]=${child}&attr.size[eq]=xl`)).toBe('INVALID_QUERY');
      expect(await bad('sort=relevance')).toBe('INVALID_QUERY');
      expect(await bad('q=x')).toBe('INVALID_QUERY');
      expect(await bad('price[gte]=abc')).toBe('INVALID_QUERY');
      expect(await bad('status[eq]=draft')).toBe('INVALID_QUERY');
    });

    it('sorts by price with cursor pagination and no duplicates or gaps', async () => {
      const seen: string[] = [];
      let cursor = '';
      for (let i = 0; i < 5; i += 1) {
        const page = await list(`sort=minPrice&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...page.data.map((p) => p.name));
        if (!page.meta?.hasMore) break;
        cursor = page.meta.nextCursor ?? '';
      }
      expect(seen).toEqual(['Headphones', 'Wireless Headphones', 'Studio Speaker']);
    });

    it('q searches the full text, tolerates typos, ranks, and pages by relevance', async () => {
      expect((await names('q=headphones')).sort()).toEqual(['Headphones', 'Wireless Headphones']);
      expect(await names('q=headphnes')).toContain('Headphones');
      expect(await names('q=speaker description')).toEqual(['Studio Speaker']);
      expect(await names('q=Hidden Draft')).toEqual([]);

      const ranked = await names('q=headphones');
      const seen: string[] = [];
      let cursor = '';
      for (let i = 0; i < 5; i += 1) {
        const page = await list(
          `q=headphones&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        seen.push(...page.data.map((p) => p.name));
        if (!page.meta?.hasMore) break;
        cursor = page.meta.nextCursor ?? '';
      }
      expect(seen).toEqual(ranked);
    });
  });

  describe('GET /products/:idOrSlug', () => {
    it('returns a visible product by id or slug, with used options only and live stock', async () => {
      const byId = await get(`/products/${headphones.id}`);
      expect(byId.status).toBe(200);
      const product = successBody<ProductDetailDto>(byId).data;
      expect(successBody<ProductDetailDto>(await get(`/products/${headphones.slug}`)).data).toEqual(product);

      expect(product.category).toMatchObject({ id: child, name: 'Audio' });
      expect(product.category.path.map((c) => c.id)).toEqual([root, child]);
      expect(product.attributes).toEqual([
        {
          code: 'color',
          name: 'color',
          options: [
            { code: 'red', value: 'RED' },
            { code: 'blue', value: 'BLUE' },
          ],
        },
        {
          code: 'size',
          name: 'size',
          options: [
            { code: 's', value: 'S' },
            { code: 'xl', value: 'XL' },
          ],
        },
      ]);
      expect(product.variants.map((v) => [v.price, v.inStock, v.availableQuantity])).toEqual([
        ['150.00', true, 3],
        ['99.00', false, 0],
      ]);
      expect(product).toMatchObject({ minPrice: '99.00', maxPrice: '150.00', inStock: true });

      const capped = successBody<ProductDetailDto>(await get(`/products/${simple.id}`)).data;
      expect(capped.variants[0]?.availableQuantity).toBe(99);
    });

    it('404 for hidden, deleted and unknown products; 400 for a malformed key', async () => {
      expect(code(await get(`/products/${draft.id}`))).toBe('PRODUCT_NOT_FOUND');
      expect(code(await get(`/products/${draft.slug}`))).toBe('PRODUCT_NOT_FOUND');
      expect((await get(`/products/${UNKNOWN_ID}`)).status).toBe(404);
      expect((await get('/products/Not_A_Slug!')).status).toBe(400);

      const doomed = await api.product(other.token, flat, 'Doomed lamp', [{ price: '9.00', stock: 1 }]);
      expect((await get(`/products/${doomed.id}`)).status).toBe(200);
      await api.send('delete', other.token, `/seller/products/${doomed.id}`);
      expect((await get(`/products/${doomed.id}`)).status).toBe(404);
    });

    it('caches the static part, invalidates it on seller writes, and never caches stock', async () => {
      const item = await api.product(seller.token, flat, 'Cached mug', [{ price: '12.00', stock: 2 }]);
      const key = productDetailCacheKey(item.id);
      await get(`/products/${item.id}`);
      expect(await t.infra.cache.get(key)).not.toBeNull();

      // Stock changes show at once, without touching the cache.
      await request(t.app)
        .post(`${API}/seller/variants/${item.variants[0]?.id ?? ''}/stock-adjustments`)
        .set('Authorization', `Bearer ${seller.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ delta: 5 });
      const fresh = successBody<ProductDetailDto>(await get(`/products/${item.id}`)).data;
      expect(fresh.variants[0]?.availableQuantity).toBe(7);

      await api.send(
        'patch',
        seller.token,
        `/seller/products/${item.id}/variants/${item.variants[0]?.id ?? ''}`,
        {
          price: '15.00',
        },
      );
      expect(await t.infra.cache.get(key)).toBeNull();
      expect(successBody<ProductDetailDto>(await get(`/products/${item.id}`)).data.variants[0]?.price).toBe(
        '15.00',
      );
    });
  });

  describe('getVariantsForPurchase (spec 06 §2)', () => {
    it('one call: purchasable only when the variant, product and seller are all live and active', async () => {
      const directory = t.container.resolve<ICatalogDirectory>(TOKENS.CatalogDirectory);
      const inactive = await api.product(seller.token, child, 'Two-variant earbuds', [
        { optionIds: [size.s ?? '', color.blue ?? ''], price: '40.00', stock: 1 },
        { optionIds: [size.xl ?? '', color.blue ?? ''], price: '45.00', stock: 1, status: 'inactive' },
      ]);
      const deletedVariant = await api.product(seller.token, flat, 'Gone', [{ price: '1.00', stock: 1 }]);
      await api.send('delete', seller.token, `/seller/products/${deletedVariant.id}`);
      const hiddenSeller = await api.product(other.token, flat, 'Suspended stuff', [
        { price: '2.00', stock: 1 },
      ]);
      await t.infra.db.knex('products').where({ id: hiddenSeller.id }).update({ seller_active: false });

      const ids = [
        headphones.variants[0]?.id ?? '',
        draft.variants[0]?.id ?? '',
        inactive.variants[1]?.id ?? '',
        deletedVariant.variants[0]?.id ?? '',
        hiddenSeller.variants[0]?.id ?? '',
        UNKNOWN_ID,
      ];
      const result = await directory.getVariantsForPurchase(ids);
      const byId = new Map(result.map((v) => [v.variantId, v]));
      expect(result).toHaveLength(5);
      expect(byId.get(ids[0] ?? '')).toEqual({
        variantId: ids[0],
        productId: headphones.id,
        productName: 'Wireless Headphones',
        productSlug: headphones.slug,
        sku: expect.stringMatching(/^SKU-/) as unknown,
        price: '150.00',
        sellerId: seller.sellerId,
        attributes: [
          { attribute: 'color', value: 'BLUE' },
          { attribute: 'size', value: 'XL' },
        ],
        purchasable: true,
      });
      for (const id of ids.slice(1, 5)) expect(byId.get(id)?.purchasable, id).toBe(false);
      expect(await directory.getVariantsForPurchase([])).toEqual([]);
    });
  });
});
