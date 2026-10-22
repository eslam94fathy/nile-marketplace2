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

interface MyReview {
  id: string;
  productId: string;
  rating: number;
  title: string | null;
  body: string | null;
  images: { id: string }[];
  reviewer: { displayName: string };
  variantOptions: { attribute: string; value: string }[];
  reply: { body: string } | null;
  status: string;
  product: { id: string; slug: string; name: string };
  canEdit: boolean;
  editedAt: string | null;
}

interface Stats {
  rating_count: number;
  rating_sum: number;
  count_1: number;
  count_2: number;
  count_3: number;
  count_4: number;
  count_5: number;
  version: string;
}

/*
 * Spec 17 §4.2 (UC-RV-1, UC-RV-2): customers write, edit and delete reviews of delivered items, and the
 * product and seller aggregates (§1.2) follow exactly, on real Postgres.
 */
describe('reviews: customer endpoints', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  const knex = () => t.infra.db.knex;

  /** A customer with a delivered order item of a fresh seller's product, delivered `daysAgo` days ago. */
  async function deliveredItem(
    options: {
      daysAgo?: number;
      status?: string;
      cancelled?: boolean;
      buyer?: Awaited<ReturnType<typeof api.customer>>;
    } = {},
  ) {
    const buyer = options.buyer ?? (await api.customer());
    const { sellerId, productId, variantId } = await api.fx.insertVariantChain();
    const status = options.status ?? 'delivered';
    const orderId = await api.fx.insertOrder(buyer.customerId);
    const sellerOrderId = await api.fx.insertSellerOrder(orderId, sellerId, {
      status,
      delivered_at: status === 'delivered' ? new Date(Date.now() - (options.daysAgo ?? 1) * DAY_MS) : null,
    });
    const orderItemId = await api.fx.insertOrderItem(
      sellerOrderId,
      { variantId, productId },
      options.cancelled ? { cancelled_quantity: 2, line_total: '0.00' } : {},
    );
    return { buyer, sellerId, productId, variantId, orderItemId };
  }

  const post = (token: string, body: object) =>
    request(t.app).post(`${API}/reviews`).set('Authorization', `Bearer ${token}`).send(body);
  const stats = async (subjectType: 'product' | 'seller', subjectId: string) =>
    knex()('review_rating_stats')
      .where({ subject_type: subjectType, subject_id: subjectId })
      .first<Stats | undefined>(
        'rating_count',
        'rating_sum',
        'count_1',
        'count_2',
        'count_3',
        'count_4',
        'count_5',
        'version',
      );
  const ratingEvents = async (productId: string) =>
    (
      await knex()('events_outbox')
        .where({ event_type: 'review.rating_changed', aggregate_id: productId })
        .orderBy('id')
        .select<{ payload: Record<string, unknown> }[]>('payload')
    ).map((row) => row.payload);

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
  });
  afterAll(async () => {
    await t.close();
  });

  describe('POST /reviews', () => {
    it('reviews a delivered item: published, with images, reviewer name, variant snapshot; aggregates and events', async () => {
      const item = await deliveredItem();
      const mediaId = await insertReadyMedia(t, item.buyer.userId, 'review_image');
      const res = await post(item.buyer.token, {
        orderItemId: item.orderItemId,
        rating: 4,
        title: 'Good phone',
        body: 'Battery lasts.',
        imageMediaIds: [mediaId],
      });

      expect(res.status).toBe(201);
      const review = successBody<MyReview>(res).data;
      expect(review).toMatchObject({
        productId: item.productId,
        rating: 4,
        title: 'Good phone',
        images: [{ id: mediaId }],
        reviewer: { displayName: 'Mona A.' },
        variantOptions: [{ attribute: 'Color', value: 'Black' }],
        reply: null,
        status: 'published',
        product: { id: item.productId, name: 'Phone' },
        canEdit: true,
        editedAt: null,
      });
      const counts = {
        rating_count: 1,
        rating_sum: 4,
        count_1: 0,
        count_2: 0,
        count_3: 0,
        count_4: 1,
        count_5: 0,
      };
      expect(await stats('product', item.productId)).toEqual({ ...counts, version: '1' });
      expect(await stats('seller', item.sellerId)).toEqual({ ...counts, version: '1' });
      expect(await ratingEvents(item.productId)).toEqual([
        {
          product: { productId: item.productId, ratingCount: 1, ratingSum: 4, version: 1 },
          seller: { sellerId: item.sellerId, ratingCount: 1, ratingSum: 4, version: 1 },
        },
      ]);
      expect(await api.eventsOf('review.created', review.id)).toEqual([
        {
          reviewId: review.id,
          productId: item.productId,
          sellerId: item.sellerId,
          customerId: item.buyer.customerId,
          rating: 4,
        },
      ]);
      const media = await knex()('media_objects')
        .where({ id: mediaId })
        .first<{ claimed_at: Date | null }>('claimed_at');
      expect(media?.claimed_at).not.toBeNull();
    });

    it('a rating alone is a review; a second review of the product is 409, even under two parallel posts', async () => {
      const item = await deliveredItem();
      const body = { orderItemId: item.orderItemId, rating: 5 };
      const results = await Promise.all([post(item.buyer.token, body), post(item.buyer.token, body)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const conflict = results.find((r) => r.status === 409);
      expect(conflict && errorBody(conflict).error.code).toBe('REVIEW_ALREADY_EXISTS');
      expect((await stats('product', item.productId))?.rating_count).toBe(1);
      // Another delivered item of the same product still counts as the same product (RV-1).
      const again = await deliveredItem({ buyer: item.buyer });
      await knex()('order_items')
        .where({ id: again.orderItemId })
        .update({ product_id: item.productId, variant_id: item.variantId });
      expect((await post(item.buyer.token, { orderItemId: again.orderItemId, rating: 1 })).status).toBe(409);
    });

    it('parallel reviews of one product by several customers leave exact aggregates', async () => {
      const first = await deliveredItem();
      const others = [];
      for (let i = 0; i < 4; i += 1) {
        const item = await deliveredItem();
        // The same product and seller as the first item.
        await knex()('order_items')
          .where({ id: item.orderItemId })
          .update({ product_id: first.productId, variant_id: first.variantId });
        const so = await knex()('order_items')
          .where({ id: item.orderItemId })
          .first<{ seller_order_id: string }>('seller_order_id');
        await knex()('seller_orders')
          .where({ id: so?.seller_order_id })
          .update({ seller_id: first.sellerId });
        others.push(item);
      }
      const ratings = [5, 4, 4, 2, 1];
      const results = await Promise.all(
        [first, ...others].map((item, i) =>
          post(item.buyer.token, { orderItemId: item.orderItemId, rating: ratings[i] }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      const expected = {
        rating_count: 5,
        rating_sum: 16,
        count_1: 1,
        count_2: 1,
        count_3: 0,
        count_4: 2,
        count_5: 1,
        version: '5',
      };
      expect(await stats('product', first.productId)).toEqual(expected);
      expect(await stats('seller', first.sellerId)).toEqual(expected);
    });

    it('422 for an item that is not a delivered, open item of the customer, or outside the window', async () => {
      const item = await deliveredItem();
      const expectCode = async (token: string, orderItemId: string, code: string) => {
        const res = await post(token, { orderItemId, rating: 3 });
        expect(res.status, code).toBe(422);
        expect(errorBody(res).error.code).toBe(code);
      };
      const stranger = await api.customer();
      await expectCode(stranger.token, item.orderItemId, 'REVIEW_NOT_ALLOWED');
      await expectCode(item.buyer.token, UNKNOWN_ID, 'REVIEW_NOT_ALLOWED');
      const shipping = await deliveredItem({ status: 'out_for_delivery' });
      await expectCode(shipping.buyer.token, shipping.orderItemId, 'REVIEW_NOT_ALLOWED');
      const cancelled = await deliveredItem({ cancelled: true });
      await expectCode(cancelled.buyer.token, cancelled.orderItemId, 'REVIEW_NOT_ALLOWED');
      const late = await deliveredItem({ daysAgo: 61 });
      await expectCode(late.buyer.token, late.orderItemId, 'REVIEW_WINDOW_CLOSED');

      const othersImage = await insertReadyMedia(t, stranger.userId, 'review_image');
      const res = await post(item.buyer.token, {
        orderItemId: item.orderItemId,
        rating: 3,
        imageMediaIds: [othersImage],
      });
      expect(res.status).toBe(422);
      expect(errorBody(res).error.code).toBe('MEDIA_NOT_ATTACHABLE');
      // Rolled back: no review, no aggregate.
      expect(await stats('product', item.productId)).toBeUndefined();
    });

    it('400 for bad fields; 401 without a token, 403 for other roles', async () => {
      const item = await deliveredItem();
      for (const body of [
        { orderItemId: item.orderItemId, rating: 0 },
        { orderItemId: item.orderItemId, rating: 6 },
        { orderItemId: item.orderItemId, rating: 4.5 },
        { orderItemId: item.orderItemId, rating: 4, title: '' },
        { orderItemId: item.orderItemId, rating: 4, body: 'x'.repeat(2001) },
        { orderItemId: item.orderItemId, rating: 4, imageMediaIds: [UNKNOWN_ID, UNKNOWN_ID] },
        { orderItemId: item.orderItemId, rating: 4, verified: true },
        { rating: 4 },
      ]) {
        const res = await post(item.buyer.token, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect((await request(t.app).post(`${API}/reviews`).send({})).status).toBe(401);
      const seller = await signTestAccessToken({ sub: item.buyer.userId, role: 'seller' });
      expect((await post(seller, { orderItemId: item.orderItemId, rating: 4 })).status).toBe(403);
    });
  });

  describe('edit and delete', () => {
    async function reviewed(rating = 4) {
      const item = await deliveredItem();
      const res = await post(item.buyer.token, { orderItemId: item.orderItemId, rating });
      expect(res.status).toBe(201);
      return { ...item, reviewId: successBody<MyReview>(res).data.id };
    }
    const patch = (token: string, reviewId: string, body: object) =>
      request(t.app)
        .patch(`${API}/me/reviews/${reviewId}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    const remove = (token: string, reviewId: string) =>
      request(t.app).delete(`${API}/me/reviews/${reviewId}`).set('Authorization', `Bearer ${token}`);

    it('a rating edit moves both aggregates by the difference; texts and images change, editedAt set', async () => {
      const r = await reviewed(2);
      const first = await insertReadyMedia(t, r.buyer.userId, 'review_image');
      const second = await insertReadyMedia(t, r.buyer.userId, 'review_image');
      expect((await patch(r.buyer.token, r.reviewId, { imageMediaIds: [first] })).status).toBe(200);
      const res = await patch(r.buyer.token, r.reviewId, { rating: 5, title: null, imageMediaIds: [second] });
      expect(res.status).toBe(200);
      expect(successBody<MyReview>(res).data).toMatchObject({
        rating: 5,
        title: null,
        images: [{ id: second }],
      });
      expect(successBody<MyReview>(res).data.editedAt).not.toBeNull();

      const expected = {
        rating_count: 1,
        rating_sum: 5,
        count_1: 0,
        count_2: 0,
        count_3: 0,
        count_4: 0,
        count_5: 1,
        version: '2',
      };
      expect(await stats('product', r.productId)).toEqual(expected);
      expect(await stats('seller', r.sellerId)).toEqual(expected);
      // The dropped image is released for the cleanup job; the new one is claimed.
      const media = await knex()('media_objects')
        .whereIn('id', [first, second])
        .select<{ id: string; claimed_at: Date | null; released_at: Date | null }[]>(
          'id',
          'claimed_at',
          'released_at',
        );
      expect(media.find((m) => m.id === first)?.released_at).not.toBeNull();
      expect(media.find((m) => m.id === second)?.released_at).toBeNull();
      // Texts only: no aggregate change, no event.
      const events = (await ratingEvents(r.productId)).length;
      expect((await patch(r.buyer.token, r.reviewId, { body: 'Updated' })).status).toBe(200);
      expect(await ratingEvents(r.productId)).toHaveLength(events);
    });

    it('a hidden review can be edited, stays hidden and moves no aggregate', async () => {
      const r = await reviewed(4);
      const admin = await api.fx.insertUser('admin');
      await knex()('product_reviews').where({ id: r.reviewId }).update({
        status: 'hidden',
        hidden_reason: 'Off topic',
        hidden_by_user_id: admin,
        hidden_at: new Date(),
      });
      const before = await stats('product', r.productId);
      const res = await patch(r.buyer.token, r.reviewId, { rating: 1 });
      expect(successBody<MyReview>(res).data).toMatchObject({ status: 'hidden', rating: 1 });
      expect(await stats('product', r.productId)).toEqual(before);
    });

    it("editing after REVIEW_EDIT_WINDOW_DAYS is 422; an empty patch 400; another customer's review 404", async () => {
      const r = await reviewed();
      const stranger = await api.customer();
      expect((await patch(stranger.token, r.reviewId, { rating: 1 })).status).toBe(404);
      expect((await patch(r.buyer.token, r.reviewId, {})).status).toBe(400);
      await knex()('product_reviews')
        .where({ id: r.reviewId })
        .update({ created_at: new Date(Date.now() - 31 * DAY_MS) });
      const late = await patch(r.buyer.token, r.reviewId, { rating: 1 });
      expect(late.status).toBe(422);
      expect(errorBody(late).error.code).toBe('REVIEW_EDIT_WINDOW_CLOSED');
      const mine = successBody<MyReview>(
        await request(t.app)
          .get(`${API}/me/reviews/${r.reviewId}`)
          .set('Authorization', `Bearer ${r.buyer.token}`),
      ).data;
      expect(mine.canEdit).toBe(false);
    });

    it('delete: aggregates decremented, images released, gone from my reviews; the product can be reviewed again (RV-4)', async () => {
      const r = await reviewed(3);
      const image = await insertReadyMedia(t, r.buyer.userId, 'review_image');
      await patch(r.buyer.token, r.reviewId, { imageMediaIds: [image] });
      expect((await remove(r.buyer.token, r.reviewId)).status).toBe(204);
      expect(await stats('product', r.productId)).toMatchObject({
        rating_count: 0,
        rating_sum: 0,
        count_3: 0,
      });
      const media = await knex()('media_objects')
        .where({ id: image })
        .first<{ released_at: Date | null }>('released_at');
      expect(media?.released_at).not.toBeNull();
      expect((await remove(r.buyer.token, r.reviewId)).status).toBe(404);
      const again = await post(r.buyer.token, { orderItemId: r.orderItemId, rating: 5 });
      expect(again.status).toBe(201);
      expect(await stats('product', r.productId)).toMatchObject({ rating_count: 1, rating_sum: 5 });
    });
  });

  describe('my reviews and reviewable items', () => {
    it('lists my reviews newest first; reviewable items leave reviewed products and old deliveries out', async () => {
      const buyer = await api.customer();
      const reviewedItem = await deliveredItem({ buyer, daysAgo: 3 });
      const open = await deliveredItem({ buyer, daysAgo: 2 });
      const newest = await deliveredItem({ buyer, daysAgo: 1 });
      await deliveredItem({ buyer, daysAgo: 61 });
      expect((await post(buyer.token, { orderItemId: reviewedItem.orderItemId, rating: 4 })).status).toBe(
        201,
      );

      const auth = (path: string) =>
        request(t.app).get(`${API}${path}`).set('Authorization', `Bearer ${buyer.token}`);
      const mine = successBody<MyReview[]>(await auth('/me/reviews')).data;
      expect(mine.map((r) => r.productId)).toEqual([reviewedItem.productId]);

      const items = successBody<{ orderItemId: string; reviewWindowEndsAt: string }[]>(
        await auth('/me/reviewable-items'),
      ).data;
      expect(items.map((i) => i.orderItemId)).toEqual([newest.orderItemId, open.orderItemId]);
      const firstPage = await auth('/me/reviewable-items?limit=1');
      const cursor = successBody<unknown[]>(firstPage).meta?.nextCursor ?? '';
      const second = successBody<{ orderItemId: string }[]>(
        await auth(`/me/reviewable-items?limit=1&cursor=${cursor}`),
      ).data;
      expect(second.map((i) => i.orderItemId)).toEqual([open.orderItemId]);
      expect((await auth('/me/reviewable-items?sort=deliveredAt')).status).toBe(400);
      expect((await auth(`/me/reviews/${UNKNOWN_ID}`)).status).toBe(404);
    });
  });
});
