import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AdminAttributeDto,
  type AdminCategoryNodeDto,
  type AttributeOptionDto,
  type CategoryNodeDto,
  type EffectiveAttributeDto,
} from '../../src/app/catalog/dto/category-response.dto';
import { CATEGORY_TREE_CACHE_KEY } from '../../src/app/catalog/constants';
import { catalogFixtures } from '../helpers/catalog-fixtures';
import { customerFixtures } from '../helpers/customers';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '01920d3e-7a1c-7c2b-9a4e-3f0c2d1b6a55';

describe('catalog: category tree, attributes, options (spec 06 §4.1–§4.2)', () => {
  let t: TestApp;
  let adminToken: string;
  let customerToken: string;

  const as = (token: string | null) => {
    const auth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
    return {
      get: (path: string) => auth(request(t.app).get(`${API}${path}`)),
      post: (path: string, body?: object) => auth(request(t.app).post(`${API}${path}`)).send(body),
      patch: (path: string, body?: object) => auth(request(t.app).patch(`${API}${path}`)).send(body),
      delete: (path: string) => auth(request(t.app).delete(`${API}${path}`)),
    };
  };
  const admin = () => as(adminToken);
  const unique = () => randomUUID().slice(0, 8);
  const code = (res: request.Response) => errorBody(res).error.code;

  const createCategory = async (body: Record<string, unknown> = {}): Promise<AdminCategoryNodeDto> => {
    const res = await admin().post('/admin/categories', { name: `Cat ${unique()}`, sortOrder: 0, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return successBody<AdminCategoryNodeDto>(res).data;
  };
  const addAttribute = async (categoryId: string, body: Record<string, unknown> = {}) => {
    const res = await admin().post(`/admin/categories/${categoryId}/attributes`, {
      name: 'Size',
      code: `size-${unique()}`,
      sortOrder: 0,
      ...body,
    });
    return res;
  };
  /** A seller product (SQL fixture) in this category. */
  const productIn = async (categoryId: string, overrides: Record<string, unknown> = {}) => {
    const fx = catalogFixtures(t.infra.db.knex);
    const { sellerId } = await fx.insertSeller();
    return { productId: await fx.insertProduct(sellerId, categoryId, overrides), sellerId, fx };
  };

  beforeAll(async () => {
    t = await startTestApp();
    const fx = customerFixtures(t);
    adminToken = (await fx.createActiveAdmin()).session.accessToken;
    customerToken = (await fx.createActiveCustomer()).accessToken;
  });
  afterAll(async () => {
    await t.close();
  });

  describe('authorization (every admin route)', () => {
    const routes: [string, string][] = [
      ['get', '/admin/categories'],
      ['post', '/admin/categories'],
      ['patch', `/admin/categories/${UNKNOWN_ID}`],
      ['post', `/admin/categories/${UNKNOWN_ID}/attributes`],
      ['patch', `/admin/attributes/${UNKNOWN_ID}`],
      ['delete', `/admin/attributes/${UNKNOWN_ID}`],
      ['post', `/admin/attributes/${UNKNOWN_ID}/options`],
      ['patch', `/admin/options/${UNKNOWN_ID}`],
      ['delete', `/admin/options/${UNKNOWN_ID}`],
    ];
    it.each(routes)('%s %s: 401 anonymous, 403 for a customer', async (method, path) => {
      const call = (token: string | null) =>
        (as(token) as Record<string, (p: string, b?: object) => request.Test>)[method]?.(path, {}) ??
        Promise.reject(new Error(method));
      expect((await call(null)).status).toBe(401);
      expect((await call(customerToken)).status).toBe(403);
    });
  });

  describe('categories', () => {
    it('creates a 3-level tree with derived slugs and depths; depth 4 is refused', async () => {
      const name = `Home Appliances ${unique()}`;
      const root = await createCategory({ name, sortOrder: 5 });
      expect(root).toMatchObject({
        parentId: null,
        depth: 1,
        sortOrder: 5,
        isActive: true,
        children: [],
        attributes: [],
      });
      expect(root.slug).toBe(name.toLowerCase().replace(/ /g, '-'));
      const child = await createCategory({ parentId: root.id });
      const grandchild = await createCategory({ parentId: child.id });
      expect([child.depth, grandchild.depth]).toEqual([2, 3]);

      const tooDeep = await admin().post('/admin/categories', {
        parentId: grandchild.id,
        name: 'Deep',
        sortOrder: 0,
      });
      expect([tooDeep.status, code(tooDeep)]).toEqual([422, 'CATEGORY_MAX_DEPTH_EXCEEDED']);

      const tree = successBody<AdminCategoryNodeDto[]>(await admin().get('/admin/categories')).data;
      const found = tree.find((node) => node.id === root.id);
      expect(found?.children[0]?.children[0]?.id).toBe(grandchild.id);
    });

    it('rejects duplicate sibling names (any case), taken slugs, underivable slugs, unknown parents', async () => {
      const name = `Books ${unique()}`;
      const first = await createCategory({ name });
      const sameName = await admin().post('/admin/categories', {
        name: name.toUpperCase(),
        slug: `x-${unique()}`,
        sortOrder: 0,
      });
      expect([sameName.status, code(sameName)]).toEqual([409, 'CATEGORY_NAME_TAKEN']);
      const sameSlug = await admin().post('/admin/categories', {
        name: `Other ${unique()}`,
        slug: first.slug,
        sortOrder: 0,
      });
      expect([sameSlug.status, code(sameSlug)]).toEqual([409, 'CATEGORY_SLUG_TAKEN']);
      const noSlug = await admin().post('/admin/categories', { name: '!!!', sortOrder: 0 });
      expect([noSlug.status, code(noSlug)]).toEqual([422, 'CATEGORY_SLUG_REQUIRED']);
      const unknownParent = await admin().post('/admin/categories', {
        parentId: UNKNOWN_ID,
        name: 'X',
        sortOrder: 0,
      });
      expect([unknownParent.status, code(unknownParent)]).toEqual([422, 'CATEGORY_NOT_FOUND']);
      // The same name under another parent is fine.
      await createCategory({ parentId: first.id, name, slug: `books-child-${unique()}` });
    });

    it('validates the body strictly', async () => {
      const cases = [
        {},
        { name: 'X', sortOrder: -1 },
        { name: 'X', sortOrder: '1' },
        { name: 'X', sortOrder: 1, slug: 'Not A Slug' },
        { name: '', sortOrder: 1 },
        { name: 'X', sortOrder: 1, extra: true },
        { name: 'X', sortOrder: 1, parentId: 'nope' },
      ];
      for (const body of cases) {
        const res = await admin().post('/admin/categories', body);
        expect([res.status, code(res)], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
      }
      const empty = await admin().patch(`/admin/categories/${UNKNOWN_ID}`, {});
      expect(empty.status).toBe(400);
      expect((await admin().patch('/admin/categories/not-a-uuid', { name: 'X' })).status).toBe(400);
    });

    it('PATCH updates fields; unknown id 404', async () => {
      const category = await createCategory();
      const res = await admin().patch(`/admin/categories/${category.id}`, {
        name: 'Renamed',
        sortOrder: 9,
        slug: `renamed-${unique()}`,
      });
      expect(res.status).toBe(200);
      expect(successBody<AdminCategoryNodeDto>(res).data).toMatchObject({ name: 'Renamed', sortOrder: 9 });
      const missing = await admin().patch(`/admin/categories/${UNKNOWN_ID}`, { name: 'X' });
      expect([missing.status, code(missing)]).toEqual([404, 'CATEGORY_NOT_FOUND']);
    });

    it('deactivation needs no active child and no live product; reactivation needs an active parent (CA-13)', async () => {
      const parent = await createCategory();
      const child = await createCategory({ parentId: parent.id });
      const deactivate = (id: string) => admin().patch(`/admin/categories/${id}`, { isActive: false });
      const activate = (id: string) => admin().patch(`/admin/categories/${id}`, { isActive: true });

      expect(code(await deactivate(parent.id))).toBe('CATEGORY_IN_USE');
      const { productId } = await productIn(child.id);
      expect(code(await deactivate(child.id))).toBe('CATEGORY_IN_USE');
      await t.infra.db.knex('products').where({ id: productId }).update({ deleted_at: new Date() });
      expect((await deactivate(child.id)).status).toBe(200);
      expect((await deactivate(parent.id)).status).toBe(200);

      const refused = await activate(child.id);
      expect([refused.status, code(refused)]).toEqual([409, 'CATEGORY_PARENT_INACTIVE']);
      const underInactive = await admin().post('/admin/categories', {
        parentId: parent.id,
        name: 'New',
        sortOrder: 0,
      });
      expect([underInactive.status, code(underInactive)]).toEqual([409, 'CATEGORY_PARENT_INACTIVE']);
      expect((await activate(parent.id)).status).toBe(200);
      expect((await activate(child.id)).status).toBe(200);
    });

    it('the public tree shows active categories only, and every change invalidates the cache', async () => {
      const root = await createCategory({ name: `Garden ${unique()}` });
      const child = await createCategory({ parentId: root.id });
      const publicRoot = async () =>
        successBody<CategoryNodeDto[]>(await as(null).get('/categories')).data.find((n) => n.id === root.id);

      expect((await publicRoot())?.children.map((c) => c.id)).toEqual([child.id]);
      expect(await t.infra.cache.get(CATEGORY_TREE_CACHE_KEY)).not.toBeNull();

      await admin().patch(`/admin/categories/${child.id}`, { isActive: false });
      expect(await t.infra.cache.get(CATEGORY_TREE_CACHE_KEY)).toBeNull();
      expect((await publicRoot())?.children).toEqual([]);
      const node = await publicRoot();
      expect(node).toEqual({ id: root.id, name: root.name, slug: root.slug, sortOrder: 0, children: [] });
    });
  });

  describe('attributes', () => {
    it('adds attributes with options; the public endpoint returns inherited ones, ancestors first', async () => {
      const root = await createCategory();
      const child = await createCategory({ parentId: root.id });
      expect((await addAttribute(root.id, { name: 'Brand', code: 'brand' })).status).toBe(201);
      const sizeRes = await addAttribute(child.id, { name: 'Size', code: 'size' });
      expect(sizeRes.status).toBe(201);
      const size = successBody<AdminAttributeDto>(sizeRes).data;
      expect(size).toEqual({ id: size.id, code: 'size', name: 'Size', sortOrder: 0, options: [] });

      const option = await admin().post(`/admin/attributes/${size.id}/options`, {
        value: 'XL',
        code: 'xl',
        sortOrder: 2,
      });
      expect(option.status).toBe(201);
      await admin().post(`/admin/attributes/${size.id}/options`, { value: 'S', code: 's', sortOrder: 1 });

      const res = await as(null).get(`/categories/${child.id}/attributes`);
      expect(res.status).toBe(200);
      const effective = successBody<EffectiveAttributeDto[]>(res).data;
      expect(effective.map((a) => [a.code, a.definedOnCategoryId])).toEqual([
        ['brand', root.id],
        ['size', child.id],
      ]);
      expect(effective[1]?.options.map((o) => o.code)).toEqual(['s', 'xl']);
    });

    it('public attributes: 404 for unknown or inactive categories, 400 for a bad id', async () => {
      const category = await createCategory();
      await admin().patch(`/admin/categories/${category.id}`, { isActive: false });
      expect(code(await as(null).get(`/categories/${category.id}/attributes`))).toBe('CATEGORY_NOT_FOUND');
      expect((await as(null).get(`/categories/${UNKNOWN_ID}/attributes`)).status).toBe(404);
      expect((await as(null).get('/categories/nope/attributes')).status).toBe(400);
    });

    it('rejects a code used by an ancestor, a descendant or the category itself; siblings may share it', async () => {
      const root = await createCategory();
      const left = await createCategory({ parentId: root.id });
      const right = await createCategory({ parentId: root.id });
      expect((await addAttribute(left.id, { code: 'material' })).status).toBe(201);
      expect((await addAttribute(right.id, { code: 'material' })).status).toBe(201);
      expect(code(await addAttribute(root.id, { code: 'material' }))).toBe('ATTRIBUTE_CODE_CONFLICT');
      expect((await addAttribute(root.id, { code: 'origin' })).status).toBe(201);
      expect(code(await addAttribute(left.id, { code: 'origin' }))).toBe('ATTRIBUTE_CODE_CONFLICT');
      expect(code(await addAttribute(left.id, { code: 'material' }))).toBe('ATTRIBUTE_CODE_CONFLICT');
      expect(code(await addAttribute(UNKNOWN_ID))).toBe('CATEGORY_NOT_FOUND');
    });

    it('enforces 5 effective attributes, counting what descendants already have', async () => {
      const root = await createCategory();
      const child = await createCategory({ parentId: root.id });
      for (const c of ['a1', 'a2', 'a3'])
        expect((await addAttribute(child.id, { code: c })).status).toBe(201);
      expect((await addAttribute(root.id, { code: 'r1' })).status).toBe(201);
      expect((await addAttribute(root.id, { code: 'r2' })).status).toBe(201); // child now has 5
      const res = await addAttribute(root.id, { code: 'r3' });
      expect([res.status, code(res)]).toEqual([422, 'ATTRIBUTE_LIMIT_REACHED']);
    });

    it('is blocked while the subtree has live products (S-5); deletion counts deleted products too', async () => {
      const root = await createCategory();
      const child = await createCategory({ parentId: root.id });
      const attribute = successBody<AdminAttributeDto>(await addAttribute(root.id)).data;
      const { productId } = await productIn(child.id);
      const blocked = await addAttribute(root.id);
      expect([blocked.status, code(blocked)]).toEqual([409, 'CATEGORY_HAS_PRODUCTS']);

      await t.infra.db.knex('products').where({ id: productId }).update({ deleted_at: new Date() });
      expect((await addAttribute(root.id)).status).toBe(201);
      const inUse = await admin().delete(`/admin/attributes/${attribute.id}`);
      expect([inUse.status, code(inUse)]).toEqual([409, 'ATTRIBUTE_IN_USE']);
    });

    it('PATCH renames (code immutable); DELETE removes it with its options', async () => {
      const category = await createCategory();
      const attribute = successBody<AdminAttributeDto>(await addAttribute(category.id)).data;
      await admin().post(`/admin/attributes/${attribute.id}/options`, {
        value: 'M',
        code: 'm',
        sortOrder: 0,
      });
      const renamed = await admin().patch(`/admin/attributes/${attribute.id}`, {
        name: 'Shoe size',
        sortOrder: 3,
      });
      expect(successBody<AdminAttributeDto>(renamed).data).toMatchObject({
        name: 'Shoe size',
        sortOrder: 3,
        code: attribute.code,
      });
      expect((await admin().patch(`/admin/attributes/${attribute.id}`, { code: 'other' })).status).toBe(400);

      expect((await admin().delete(`/admin/attributes/${attribute.id}`)).status).toBe(204);
      expect(code(await admin().delete(`/admin/attributes/${attribute.id}`))).toBe('ATTRIBUTE_NOT_FOUND');
      expect(code(await admin().patch(`/admin/attributes/${UNKNOWN_ID}`, { name: 'X' }))).toBe(
        'ATTRIBUTE_NOT_FOUND',
      );
      expect(
        await t.infra.db.knex('category_attribute_options').where({ attribute_id: attribute.id }),
      ).toEqual([]);
    });
  });

  describe('options', () => {
    const setup = async () => {
      const category = await createCategory();
      const attribute = successBody<AdminAttributeDto>(await addAttribute(category.id)).data;
      const res = await admin().post(`/admin/attributes/${attribute.id}/options`, {
        value: 'Red',
        code: 'red',
        sortOrder: 0,
      });
      return { category, attribute, option: successBody<AttributeOptionDto>(res).data };
    };

    it('codes are unique per attribute; PATCH changes the value; unknown ids 404', async () => {
      const { attribute, option } = await setup();
      const dup = await admin().post(`/admin/attributes/${attribute.id}/options`, {
        value: 'Rouge',
        code: 'red',
        sortOrder: 0,
      });
      expect([dup.status, code(dup)]).toEqual([409, 'OPTION_CODE_TAKEN']);
      const updated = await admin().patch(`/admin/options/${option.id}`, { value: 'Crimson' });
      expect(successBody<AttributeOptionDto>(updated).data).toEqual({ ...option, value: 'Crimson' });
      expect(code(await admin().patch(`/admin/options/${UNKNOWN_ID}`, { value: 'X' }))).toBe(
        'OPTION_NOT_FOUND',
      );
      expect(
        code(
          await admin().post(`/admin/attributes/${UNKNOWN_ID}/options`, {
            value: 'X',
            code: 'x',
            sortOrder: 0,
          }),
        ),
      ).toBe('ATTRIBUTE_NOT_FOUND');
    });

    it('caps options at 100 per attribute', async () => {
      const { attribute } = await setup();
      const rows = Array.from({ length: 99 }, (_, i) => ({
        attribute_id: attribute.id,
        value: `V${i}`,
        code: `v${i}`,
        sort_order: i,
      }));
      await t.infra.db.knex('category_attribute_options').insert(rows);
      const res = await admin().post(`/admin/attributes/${attribute.id}/options`, {
        value: 'Last',
        code: 'last',
        sortOrder: 0,
      });
      expect([res.status, code(res)]).toEqual([422, 'OPTION_LIMIT_REACHED']);
    });

    it('an option used by a variant cannot be deleted, including a variant committed during the delete (CA-11)', async () => {
      const { category, attribute, option } = await setup();
      const { productId, sellerId, fx } = await productIn(category.id);
      const usedVariant = await fx.insertVariant(productId, sellerId);
      await t.infra.db
        .knex('variant_attribute_values')
        .insert({ variant_id: usedVariant, attribute_id: attribute.id, option_id: option.id });
      expect(code(await admin().delete(`/admin/options/${option.id}`))).toBe('OPTION_IN_USE');

      // Race: the app check passes (the insert isn't committed yet), then the FK refuses the delete.
      const free = successBody<AttributeOptionDto>(
        await admin().post(`/admin/attributes/${attribute.id}/options`, {
          value: 'Blue',
          code: 'blue',
          sortOrder: 1,
        }),
      ).data;
      const racingVariant = await fx.insertVariant(productId, sellerId);
      const trx = await t.infra.db.knex.transaction();
      await trx('variant_attribute_values').insert({
        variant_id: racingVariant,
        attribute_id: attribute.id,
        option_id: free.id,
      });
      const pending = admin()
        .delete(`/admin/options/${free.id}`)
        .then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await trx.commit();
      const res = await pending;
      expect([res.status, code(res)]).toEqual([409, 'OPTION_IN_USE']);
    });

    it('an unused option is deleted', async () => {
      const { option } = await setup();
      expect((await admin().delete(`/admin/options/${option.id}`)).status).toBe(204);
      expect(code(await admin().delete(`/admin/options/${option.id}`))).toBe('OPTION_NOT_FOUND');
    });
  });
});
