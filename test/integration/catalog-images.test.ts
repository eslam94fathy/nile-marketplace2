import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AdminCategoryNodeDto,
  type CategoryNodeDto,
} from '../../src/app/catalog/dto/category-response.dto';
import { type ProductImageDto } from '../../src/app/catalog/dto/product-image.dto';
import { type ProductDetailDto, type ProductListItemDto } from '../../src/app/catalog/dto/product-public.dto';
import {
  type SellerProductDetailDto,
  type SellerProductDto,
} from '../../src/app/catalog/dto/product-response.dto';
import { catalogApi } from '../helpers/catalog-api';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { insertReadyMedia } from '../helpers/media';
import { sellerFixtures } from '../helpers/sellers';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

/* Spec 06 §8: product images (seller) and category images (admin), and how reads show them. */
describe('catalog images', () => {
  let t: TestApp;
  let api: ReturnType<typeof catalogApi>;
  let admin: { userId: string; token: string };
  let categoryId: string;

  const images = (token: string, productId: string) => {
    const base = `${API}/seller/products/${productId}/images`;
    const auth = { Authorization: `Bearer ${token}` };
    return {
      add: (body: object) => request(t.app).post(base).set(auth).send(body),
      update: (mediaId: string, body: object) =>
        request(t.app).patch(`${base}/${mediaId}`).set(auth).send(body),
      reorder: (imageIds: string[]) => request(t.app).put(`${base}/order`).set(auth).send({ imageIds }),
      remove: (mediaId: string) => request(t.app).delete(`${base}/${mediaId}`).set(auth),
    };
  };
  const ids = (res: request.Response) => successBody<ProductImageDto[]>(res).data.map((image) => image.id);
  const mediaRow = (id: string) =>
    t.infra.db
      .knex('media_objects')
      .where({ id })
      .first<{ claimed_at: Date | null; released_at: Date | null }>();
  const publicDetail = async (productId: string) =>
    successBody<ProductDetailDto>(await request(t.app).get(`${API}/products/${productId}`)).data;

  /** An approved seller with an active product of two variants (sizes S and M), in a category of its own. */
  async function sellerWithProduct() {
    const seller = await api.approvedSeller();
    const category = (await api.category({ parentId: categoryId })).id;
    const size = await api.attribute(category, 'size', ['s', 'm']);
    const product = await api.product(seller.token, category, `Shirt ${randomUUID().slice(0, 6)}`, [
      { price: '10.00', stock: 3, optionIds: [size.s ?? ''] },
      { price: '12.00', stock: 3, optionIds: [size.m ?? ''] },
    ]);
    const media = () => insertReadyMedia(t, seller.userId, 'product_image');
    return { seller, product, media, images: images(seller.token, product.id) };
  }

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '10000' } });
    const created = await sellerFixtures(t).createActiveAdmin();
    admin = { userId: created.userId, token: created.session.accessToken };
    api = catalogApi(t, admin.token);
    categoryId = (await api.category()).id;
  });
  afterAll(async () => {
    await t.close();
  });

  describe('product images (seller)', () => {
    it('adds at the end, at a position (shifting the later ones) and past the end; claims the media', async () => {
      const { media, images: img } = await sellerWithProduct();
      const [a, b, c, d] = [await media(), await media(), await media(), await media()];

      const first = await img.add({ mediaId: a, altText: 'Front' });
      expect(first.status).toBe(201);
      expect(successBody<ProductImageDto[]>(first).data[0]).toMatchObject({
        id: a,
        position: 0,
        variantId: null,
        altText: 'Front',
        width: 1200,
        height: 800,
      });
      expect(successBody<ProductImageDto[]>(first).data[0]?.urls.large).toBe(
        `${t.resources.env.MEDIA_PUBLIC_BASE_URL}/public/${a}/large.webp`,
      );
      expect(ids(await img.add({ mediaId: b }))).toEqual([a, b]);
      expect(ids(await img.add({ mediaId: c, position: 0 }))).toEqual([c, a, b]);
      expect(ids(await img.add({ mediaId: d, position: 7 }))).toEqual([c, a, b, d]);
      const positions = successBody<ProductImageDto[]>(await img.reorder([c, a, b, d])).data.map(
        (i) => i.position,
      );
      expect(positions).toEqual([0, 1, 2, 3]);
      expect((await mediaRow(a))?.claimed_at).not.toBeNull();
    });

    it('at most 8 images; two parallel adds for the 8th slot → one 201, one 422', async () => {
      const { media, images: img } = await sellerWithProduct();
      for (let i = 0; i < 7; i += 1) expect((await img.add({ mediaId: await media() })).status).toBe(201);
      const results = await Promise.all([
        img.add({ mediaId: await media() }),
        img.add({ mediaId: await media() }),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([201, 422]);
      const refused = results.find((res) => res.status === 422);
      expect(refused && errorBody(refused).error.code).toBe('PRODUCT_IMAGE_LIMIT_REACHED');
    });

    it('media not attachable: not ready, another seller, wrong purpose, already attached → 422 MEDIA_NOT_ATTACHABLE', async () => {
      const { seller, media, images: img } = await sellerWithProduct();
      const other = await sellerWithProduct();
      const attached = await media();
      expect((await img.add({ mediaId: attached })).status).toBe(201);
      for (const mediaId of [
        await other.media(),
        await insertReadyMedia(t, seller.userId, 'review_image'),
        attached,
        UNKNOWN_ID,
      ]) {
        const res = await img.add({ mediaId });
        expect(res.status, mediaId).toBe(422);
        expect(errorBody(res).error.code).toBe('MEDIA_NOT_ATTACHABLE');
      }
    });

    it('validation → 400; a variant of another product → 422 VARIANT_NOT_FOUND', async () => {
      const { media, images: img } = await sellerWithProduct();
      const other = await sellerWithProduct();
      const mediaId = await media();
      for (const body of [
        { mediaId: 'nope' },
        { mediaId, altText: 'x'.repeat(201) },
        { mediaId, position: 8 },
        { mediaId, position: -1 },
        { mediaId, key: 'x' },
      ]) {
        expect((await img.add(body)).status, JSON.stringify(body)).toBe(400);
      }
      const res = await img.add({ mediaId, variantId: other.product.variants[0]?.id });
      expect(res.status).toBe(422);
      expect(errorBody(res).error.code).toBe('VARIANT_NOT_FOUND');
    });

    it('authz: customer → 403; another seller → 404 PRODUCT_NOT_FOUND; unapproved seller → 403; unknown image → 404', async () => {
      const { product, media, images: img } = await sellerWithProduct();
      const customer = await sellerFixtures(t).createActiveCustomer();
      expect((await images(customer.accessToken, product.id).add({ mediaId: await media() })).status).toBe(
        403,
      );

      const other = await sellerWithProduct();
      const stranger = await images(other.seller.token, product.id).add({ mediaId: await other.media() });
      expect(stranger.status).toBe(404);
      expect(errorBody(stranger).error.code).toBe('PRODUCT_NOT_FOUND');

      const pending = await sellerFixtures(t).createVerifiedSeller();
      const notApproved = await images(pending.accessToken, product.id).add({
        mediaId: await insertReadyMedia(t, pending.userId, 'product_image'),
      });
      expect(notApproved.status).toBe(403);
      expect(errorBody(notApproved).error.code).toBe('SELLER_NOT_APPROVED');

      for (const res of [await img.update(UNKNOWN_ID, { altText: 'x' }), await img.remove(UNKNOWN_ID)]) {
        expect(res.status).toBe(404);
        expect(errorBody(res).error.code).toBe('PRODUCT_IMAGE_NOT_FOUND');
      }
    });

    it('update ties / unties a variant and sets / clears the alt text; an empty patch → 400', async () => {
      const { product, media, images: img } = await sellerWithProduct();
      const mediaId = await media();
      await img.add({ mediaId });
      const variantId = product.variants[1]?.id ?? '';
      const tied = await img.update(mediaId, { variantId, altText: 'Back' });
      expect(tied.status).toBe(200);
      expect(successBody<ProductImageDto>(tied).data).toMatchObject({
        id: mediaId,
        variantId,
        altText: 'Back',
      });
      const untied = await img.update(mediaId, { variantId: null, altText: null });
      expect(successBody<ProductImageDto>(untied).data).toMatchObject({ variantId: null, altText: null });
      expect((await img.update(mediaId, {})).status).toBe(400);
    });

    it('reorder needs every image exactly once → else 422 PRODUCT_IMAGE_ORDER_INVALID (duplicates → 400)', async () => {
      const { media, images: img } = await sellerWithProduct();
      const [a, b, c] = [await media(), await media(), await media()];
      for (const mediaId of [a, b, c]) await img.add({ mediaId });
      expect(ids(await img.reorder([c, b, a]))).toEqual([c, b, a]);
      for (const list of [
        [c, b],
        [c, b, a, UNKNOWN_ID],
        [c, b, UNKNOWN_ID],
      ]) {
        const res = await img.reorder(list);
        expect(res.status).toBe(422);
        expect(errorBody(res).error.code).toBe('PRODUCT_IMAGE_ORDER_INVALID');
      }
      expect((await img.reorder([a, a, b])).status).toBe(400);
    });

    it('remove closes the gap and releases the media', async () => {
      const { media, images: img } = await sellerWithProduct();
      const [a, b, c] = [await media(), await media(), await media()];
      for (const mediaId of [a, b, c]) await img.add({ mediaId });
      expect((await img.remove(b)).status).toBe(204);
      expect((await mediaRow(b))?.released_at).not.toBeNull();
      const rows = await t.infra.db
        .knex('product_images')
        .where({ media_id: c })
        .first<{ position: number }>('position');
      expect(rows?.position).toBe(1);
      expect(ids(await img.reorder([c, a]))).toEqual([c, a]);
    });

    it('reads: seller list + detail, public list + detail (cache invalidated), variant image rule, variant delete unties', async () => {
      const { seller, product, media, images: img } = await sellerWithProduct();
      const [first, back] = [await media(), await media()];
      const [plain, tiedVariant] = [product.variants[0]?.id ?? '', product.variants[1]?.id ?? ''];

      // Cached before any image: the next writes must invalidate it.
      expect((await publicDetail(product.id)).images).toEqual([]);
      await img.add({ mediaId: first });
      await img.add({ mediaId: back, variantId: tiedVariant });

      const detail = await publicDetail(product.id);
      expect(detail.images.map((image) => image.id)).toEqual([first, back]);
      expect(detail.variants.find((v) => v.id === plain)?.imageId).toBe(first);
      expect(detail.variants.find((v) => v.id === tiedVariant)?.imageId).toBe(back);

      const list = successBody<ProductListItemDto[]>(
        await request(t.app).get(`${API}/products?sellerId[eq]=${seller.sellerId}`),
      ).data;
      expect(list.find((item) => item.id === product.id)?.primaryImage?.id).toBe(first);

      const auth = { Authorization: `Bearer ${seller.token}` };
      const mine = successBody<SellerProductDto[]>(
        await request(t.app).get(`${API}/seller/products`).set(auth),
      ).data;
      expect(mine.find((item) => item.id === product.id)?.primaryImage?.id).toBe(first);
      const sellerDetail = successBody<SellerProductDetailDto>(
        await request(t.app).get(`${API}/seller/products/${product.id}`).set(auth),
      ).data;
      expect(sellerDetail.images.map((image) => image.id)).toEqual([first, back]);
      expect(sellerDetail.primaryImage?.id).toBe(first);

      expect(
        (await api.send('delete', seller.token, `/seller/products/${product.id}/variants/${tiedVariant}`))
          .status,
      ).toBe(204);
      const untied = await t.infra.db
        .knex('product_images')
        .where({ media_id: back })
        .first<{ variant_id: string | null }>('variant_id');
      expect(untied?.variant_id).toBeNull();
      expect((await publicDetail(product.id)).images.map((image) => image.variantId)).toEqual([null, null]);
    });
  });

  describe('category images (admin)', () => {
    const setImage = (token: string, id: string, body: object) =>
      request(t.app)
        .put(`${API}/admin/categories/${id}/image`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    const removeImage = (token: string, id: string) =>
      request(t.app).delete(`${API}/admin/categories/${id}/image`).set('Authorization', `Bearer ${token}`);
    const publicNode = async (id: string) =>
      successBody<CategoryNodeDto[]>(await request(t.app).get(`${API}/categories`)).data.find(
        (node) => node.id === id,
      );

    it("set, replace (previous released), same image with a new alt text, remove; any admin's upload; audited", async () => {
      const category = (await api.category()).id;
      expect((await publicNode(category))?.image).toBeNull(); // caches the tree

      const otherAdmin = await sellerFixtures(t).createActiveAdmin();
      const first = await insertReadyMedia(t, otherAdmin.userId, 'category_image');
      const set = await setImage(admin.token, category, { mediaId: first, altText: 'Shoes' });
      expect(set.status).toBe(200);
      expect(successBody<AdminCategoryNodeDto>(set).data.image).toMatchObject({
        id: first,
        altText: 'Shoes',
      });
      expect((await publicNode(category))?.image?.id).toBe(first);

      const second = await insertReadyMedia(t, admin.userId, 'category_image');
      expect((await setImage(admin.token, category, { mediaId: second })).status).toBe(200);
      expect((await mediaRow(first))?.released_at).not.toBeNull();
      const again = await setImage(admin.token, category, { mediaId: second, altText: 'New text' });
      expect(again.status).toBe(200);
      expect(successBody<AdminCategoryNodeDto>(again).data.image).toMatchObject({
        id: second,
        altText: 'New text',
      });

      expect((await removeImage(admin.token, category)).status).toBe(204);
      expect((await mediaRow(second))?.released_at).not.toBeNull();
      expect((await publicNode(category))?.image).toBeNull();
      expect((await removeImage(admin.token, category)).status).toBe(204);

      const actions = await t.infra.db
        .knex('admin_audit_log')
        .where({ target_id: category })
        .orderBy('id')
        .select<{ action: string; changes: unknown }[]>('action', 'changes');
      expect(actions.map((row) => row.action)).toEqual([
        'category.created',
        'category.image_set',
        'category.image_set',
        'category.image_set',
        'category.image_removed',
      ]);
      expect(actions[1]?.changes).toEqual({
        before: { imageMediaId: null, imageAltText: null },
        after: { imageMediaId: first, imageAltText: 'Shoes' },
      });
    });

    it('errors: unknown category → 404, a product image → 422, non-admin → 403, validation → 400', async () => {
      const category = (await api.category()).id;
      const media = await insertReadyMedia(t, admin.userId, 'category_image');
      const missing = await setImage(admin.token, UNKNOWN_ID, { mediaId: media });
      expect(missing.status).toBe(404);
      expect(errorBody(missing).error.code).toBe('CATEGORY_NOT_FOUND');
      expect((await removeImage(admin.token, UNKNOWN_ID)).status).toBe(404);

      const seller = await api.approvedSeller();
      const productImage = await insertReadyMedia(t, seller.userId, 'product_image');
      const wrong = await setImage(admin.token, category, { mediaId: productImage });
      expect(wrong.status).toBe(422);
      expect(errorBody(wrong).error.code).toBe('MEDIA_NOT_ATTACHABLE');

      expect((await setImage(seller.token, category, { mediaId: media })).status).toBe(403);
      expect((await setImage(admin.token, category, { mediaId: media, altText: '' })).status).toBe(400);
    });
  });
});
