import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { insertReadyMedia } from '../helpers/media';
import { orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

const DAY_MS = 86_400_000;
const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

interface Review {
  id: string;
  rating: number;
  images: { id: string }[];
  reviewer: { displayName: string };
  reply: { body: string } | null;
}
interface SellerReview extends Review {
  product: { id: string; name: string };
  canReply: boolean;
}
interface AdminReview extends Omit<Review, 'reply'> {
  status: string;
  hiddenReason: string | null;
  reply: { body: string; hiddenAt: string | null; hiddenReason: string | null } | null;
}

/*
 * Spec 17 §4.1, §4.3, §4.4: the public list and summary, the seller's list and one reply, the admin's
 * moderation with its aggregate effects and audit rows, on real Postgres.
 */
describe('reviews: public, seller and admin endpoints', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  const knex = () => t.infra.db.knex;

  /** A visible product of a fresh approved seller, with a token for its seller. */
  const listedProduct = () => api.listedVariant();

  /** A customer's delivered item of `product`, and a review of it written through the API. */
  async function review(
    product: Awaited<ReturnType<typeof listedProduct>>,
    rating: number,
    extra: object = {},
  ) {
    const buyer = await api.customer();
    const orderId = await api.fx.insertOrder(buyer.customerId);
    const sellerOrderId = await api.fx.insertSellerOrder(orderId, product.sellerId, {
      status: 'delivered',
      delivered_at: new Date(Date.now() - DAY_MS),
    });
    const orderItemId = await api.fx.insertOrderItem(sellerOrderId, product);
    const res = await request(t.app)
      .post(`${API}/reviews`)
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ orderItemId, rating, ...extra });
    expect(res.status).toBe(201);
    return { buyer, reviewId: successBody<{ id: string }>(res).data.id };
  }

  async function admin() {
    const userId = await api.fx.insertUser('admin');
    return { userId, token: await signTestAccessToken({ sub: userId, role: 'admin' }) };
  }

  const get = (path: string, token?: string) => {
    const req = request(t.app).get(`${API}${path}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const postAs = (token: string, path: string, body: object = {}) =>
    request(t.app).post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body);
  const productStats = (productId: string) =>
    knex()('review_rating_stats')
      .where({ subject_type: 'product', subject_id: productId })
      .first<{ rating_count: number; rating_sum: number }>('rating_count', 'rating_sum');

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
  });
  afterAll(async () => {
    await t.close();
  });

  describe('public', () => {
    it('lists published reviews newest first with filters and sort; the summary is the stored aggregate', async () => {
      const product = await listedProduct();
      const first = await review(product, 5);
      const second = await review(product, 2);
      // An image on the second review, through its author.
      const secondImage = await insertReadyMedia(t, second.buyer.userId, 'review_image');
      await request(t.app)
        .patch(`${API}/me/reviews/${second.reviewId}`)
        .set('Authorization', `Bearer ${second.buyer.token}`)
        .send({ imageMediaIds: [secondImage] });
      const third = await review(product, 4);

      const ids = async (query: string) =>
        successBody<Review[]>(await get(`/products/${product.productId}/reviews${query}`)).data.map(
          (r) => r.id,
        );
      expect(await ids('')).toEqual([third.reviewId, second.reviewId, first.reviewId]);
      expect(await ids('?rating[in]=4,5')).toEqual([third.reviewId, first.reviewId]);
      expect(await ids('?hasImages[eq]=true')).toEqual([second.reviewId]);
      expect(await ids('?sort=-rating')).toEqual([first.reviewId, third.reviewId, second.reviewId]);
      const page = successBody<Review[]>(await get(`/products/${product.productId}/reviews`)).data;
      expect(page[0]?.reviewer).toEqual({ displayName: 'Mona A.' });

      const summary = await get(`/products/${product.productId}/reviews/summary`);
      expect(successBody(summary).data).toEqual({
        ratingAvg: '3.67',
        ratingCount: 3,
        distribution: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 },
      });
    });

    it('a product without reviews has an empty summary; a hidden or unknown product is 404', async () => {
      const product = await listedProduct();
      expect(successBody(await get(`/products/${product.productId}/reviews/summary`)).data).toEqual({
        ratingAvg: null,
        ratingCount: 0,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      });
      await knex()('products').where({ id: product.productId }).update({ status: 'inactive' });
      for (const path of [
        `/products/${product.productId}/reviews`,
        `/products/${UNKNOWN_ID}/reviews/summary`,
      ]) {
        const res = await get(path);
        expect(res.status, path).toBe(404);
        expect(errorBody(res).error.code).toBe('PRODUCT_NOT_FOUND');
      }
      expect((await get('/products/not-a-uuid/reviews')).status).toBe(400);
    });
  });

  describe('seller', () => {
    it('lists the reviews of my products and replies once; the reply shows publicly and notifies by event', async () => {
      const product = await listedProduct();
      const other = await listedProduct();
      const mine = await review(product, 3);
      await review(other, 5);

      const list = successBody<SellerReview[]>(await get('/seller/reviews', product.sellerToken)).data;
      expect(list.map((r) => [r.id, r.product.id, r.canReply])).toEqual([
        [mine.reviewId, product.productId, true],
      ]);

      const reply = await postAs(product.sellerToken, `/seller/reviews/${mine.reviewId}/reply`, {
        body: 'Thanks!',
      });
      expect(reply.status).toBe(201);
      expect(successBody<SellerReview>(reply).data).toMatchObject({
        reply: { body: 'Thanks!' },
        canReply: false,
      });
      const again = await postAs(product.sellerToken, `/seller/reviews/${mine.reviewId}/reply`, {
        body: 'Again',
      });
      expect(again.status).toBe(409);
      expect(errorBody(again).error.code).toBe('REVIEW_ALREADY_REPLIED');
      expect(await api.eventsOf('review.replied', mine.reviewId)).toEqual([
        { reviewId: mine.reviewId, productId: product.productId, customerId: mine.buyer.customerId },
      ]);
      const publicView = successBody<Review[]>(await get(`/products/${product.productId}/reviews`)).data;
      expect(publicView[0]?.reply).toEqual({ body: 'Thanks!', createdAt: expect.any(String) as unknown });
      expect(
        successBody<SellerReview[]>(await get('/seller/reviews?replied[eq]=false', product.sellerToken)).data,
      ).toEqual([]);
    });

    it("404 for another seller's review, 409 for a hidden one, 403 when not approved", async () => {
      const product = await listedProduct();
      const other = await listedProduct();
      const r = await review(product, 4);
      expect(
        (await postAs(other.sellerToken, `/seller/reviews/${r.reviewId}/reply`, { body: 'Hi' })).status,
      ).toBe(404);

      const support = await admin();
      expect(
        (await postAs(support.token, `/admin/reviews/${r.reviewId}/hide`, { reason: 'Spam text' })).status,
      ).toBe(200);
      const hidden = await postAs(product.sellerToken, `/seller/reviews/${r.reviewId}/reply`, { body: 'Hi' });
      expect(hidden.status).toBe(409);
      expect(errorBody(hidden).error.code).toBe('REVIEW_HIDDEN');

      await knex()('sellers').where({ id: product.sellerId }).update({ status: 'suspended' });
      const r2 = await review(other, 4);
      await knex()('sellers').where({ id: other.sellerId }).update({ status: 'suspended' });
      const suspended = await postAs(other.sellerToken, `/seller/reviews/${r2.reviewId}/reply`, {
        body: 'Hi',
      });
      expect(suspended.status).toBe(403);
      expect(errorBody(suspended).error.code).toBe('SELLER_NOT_APPROVED');
      // Reading works in any seller status, without offering a reply.
      const list = successBody<SellerReview[]>(await get('/seller/reviews', other.sellerToken)).data;
      expect(list.map((x) => x.canReply)).toEqual([false]);
      expect(
        (await postAs(other.sellerToken, `/seller/reviews/${r2.reviewId}/reply`, { body: '' })).status,
      ).toBe(400);
    });
  });

  describe('admin', () => {
    it('hide and unhide move both aggregates and leave audit rows; hidden reviews leave public responses', async () => {
      const product = await listedProduct();
      const kept = await review(product, 5);
      const r = await review(product, 1);
      const support = await admin();
      expect(await productStats(product.productId)).toEqual({ rating_count: 2, rating_sum: 6 });

      const hide = await postAs(support.token, `/admin/reviews/${r.reviewId}/hide`, {
        reason: 'Abusive words',
      });
      expect(hide.status).toBe(200);
      expect(successBody<AdminReview>(hide).data).toMatchObject({
        status: 'hidden',
        hiddenReason: 'Abusive words',
      });
      expect(await productStats(product.productId)).toEqual({ rating_count: 1, rating_sum: 5 });
      const sellerStats = await knex()('review_rating_stats')
        .where({ subject_type: 'seller', subject_id: product.sellerId })
        .first<{ rating_count: number }>('rating_count');
      expect(sellerStats?.rating_count).toBe(1);
      const publicIds = successBody<Review[]>(await get(`/products/${product.productId}/reviews`)).data.map(
        (x) => x.id,
      );
      expect(publicIds).toEqual([kept.reviewId]);
      // The author still sees it, as hidden, without the reason.
      const authorView = successBody<{ status: string }>(
        await get(`/me/reviews/${r.reviewId}`, r.buyer.token),
      ).data;
      expect(authorView).toMatchObject({ status: 'hidden' });
      expect(authorView).not.toHaveProperty('hiddenReason');

      expect(
        (await postAs(support.token, `/admin/reviews/${r.reviewId}/hide`, { reason: 'Again here' })).status,
      ).toBe(409);
      expect((await postAs(support.token, `/admin/reviews/${r.reviewId}/unhide`)).status).toBe(200);
      expect(await productStats(product.productId)).toEqual({ rating_count: 2, rating_sum: 6 });
      expect((await postAs(support.token, `/admin/reviews/${r.reviewId}/unhide`)).status).toBe(409);

      const audit = await knex()('admin_audit_log')
        .where({ target_type: 'review', target_id: r.reviewId })
        .orderBy('id')
        .select<{ action: string; actor_user_id: string; reason: string | null; changes: unknown }[]>(
          'action',
          'actor_user_id',
          'reason',
          'changes',
        );
      expect(audit).toEqual([
        {
          action: 'review.hidden',
          actor_user_id: support.userId,
          reason: 'Abusive words',
          changes: { before: { status: 'published' }, after: { status: 'hidden' } },
        },
        {
          action: 'review.unhidden',
          actor_user_id: support.userId,
          reason: null,
          changes: { before: { status: 'hidden' }, after: { status: 'published' } },
        },
      ]);
    });

    it("hides and unhides a seller's reply; admins still see it with the reason", async () => {
      const product = await listedProduct();
      const r = await review(product, 4);
      const support = await admin();
      expect(
        (await postAs(support.token, `/admin/reviews/${r.reviewId}/reply/hide`, { reason: 'No reply' }))
          .status,
      ).toBe(404);
      await postAs(product.sellerToken, `/seller/reviews/${r.reviewId}/reply`, { body: 'Rude reply' });

      const hidden = await postAs(support.token, `/admin/reviews/${r.reviewId}/reply/hide`, {
        reason: 'Rude seller',
      });
      expect(hidden.status).toBe(200);
      expect(successBody<AdminReview>(hidden).data.reply).toMatchObject({
        body: 'Rude reply',
        hiddenReason: 'Rude seller',
      });
      const publicView = successBody<Review[]>(await get(`/products/${product.productId}/reviews`)).data;
      expect(publicView[0]?.reply).toBeNull();
      expect(
        (await postAs(support.token, `/admin/reviews/${r.reviewId}/reply/hide`, { reason: 'Again here' }))
          .status,
      ).toBe(409);
      expect((await postAs(support.token, `/admin/reviews/${r.reviewId}/reply/unhide`)).status).toBe(200);
      expect(
        successBody<Review[]>(await get(`/products/${product.productId}/reviews`)).data[0]?.reply,
      ).toMatchObject({
        body: 'Rude reply',
      });
      const actions = await knex()('admin_audit_log')
        .where({ target_type: 'review_reply' })
        .orderBy('id')
        .pluck<string[]>('action');
      expect(actions).toEqual(['review_reply.hidden', 'review_reply.unhidden']);
    });

    it('lists every live review with filters; 400 for a short reason; 403 for other roles; 404 unknown', async () => {
      const product = await listedProduct();
      const low = await review(product, 1);
      await review(product, 5);
      const support = await admin();
      const ids = async (query: string) =>
        successBody<AdminReview[]>(
          await get(`/admin/reviews?productId[eq]=${product.productId}${query}`, support.token),
        ).data.map((x) => x.id);
      expect(await ids('&rating[lte]=2')).toEqual([low.reviewId]);
      await postAs(support.token, `/admin/reviews/${low.reviewId}/hide`, { reason: 'Abusive words' });
      expect(await ids('&status[eq]=hidden')).toEqual([low.reviewId]);
      expect(
        (await postAs(support.token, `/admin/reviews/${low.reviewId}/hide`, { reason: 'ab' })).status,
      ).toBe(400);
      expect((await get('/admin/reviews', low.buyer.token)).status).toBe(403);
      expect((await get('/admin/reviews')).status).toBe(401);
      expect((await get(`/admin/reviews/${UNKNOWN_ID}`, support.token)).status).toBe(404);
      expect((await postAs(support.token, `/admin/reviews/${UNKNOWN_ID}/unhide`)).status).toBe(404);
    });
  });
});
