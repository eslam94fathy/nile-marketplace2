import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import {
  type EventEnvelope,
  type EventHandlerDefinition,
  EventConsumerHost,
  OutboxDrainer,
  PermanentEventError,
} from '../../src/lib/events';
import { waitFor } from '../helpers/amqp-probe';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { createMemoryLogger } from '../helpers/memory-logger';
import { orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

const DAY_MS = 86_400_000;

/*
 * Spec 06 §9 and spec 05 §8: the `review.rating_changed` projections on products and sellers (newer
 * versions only), end to end through the worker, and the rating on public reads (filter, sort, the
 * product and seller pages).
 */
describe('rating projections and reads', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let worker: WorkerInfrastructure;
  let handlers: EventHandlerDefinition[];
  let drainer: OutboxDrainer;
  const knex = () => t.infra.db.knex;

  const ratingEvent = (
    product: { id: string; count: number; sum: number; version: number },
    seller: { id: string; count: number; sum: number; version: number },
  ): EventEnvelope => ({
    eventId: randomUUID(),
    eventType: 'review.rating_changed',
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: null,
    aggregateType: 'product',
    aggregateId: product.id,
    payload: {
      product: {
        productId: product.id,
        ratingCount: product.count,
        ratingSum: product.sum,
        version: product.version,
      },
      seller: {
        sellerId: seller.id,
        ratingCount: seller.count,
        ratingSum: seller.sum,
        version: seller.version,
      },
    },
  });
  /** Runs the catalog and sellers consumers' handlers on one event, each in its own transaction. */
  const apply = async (envelope: EventEnvelope) => {
    for (const name of ['catalog.listing-projections', 'sellers.rating-projection']) {
      const handler = handlers.find((h) => h.name === name);
      if (!handler) throw new Error(`no handler ${name}`);
      await worker.db.knex.transaction((trx) => handler.handle(envelope, trx, undefined));
    }
  };
  const productRating = (id: string) =>
    knex()('products')
      .where({ id })
      .first<{ rating_count: number; rating_avg: string | null; rating_version: string }>(
        'rating_count',
        'rating_avg',
        'rating_version',
      );
  const sellerRating = (id: string) =>
    knex()('sellers')
      .where({ id })
      .first<{ rating_count: number; rating_avg: string | null; rating_version: string }>(
        'rating_count',
        'rating_avg',
        'rating_version',
      );

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
    const { logger } = createMemoryLogger();
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    const container = createWorkerContainer(worker);
    handlers = createEventHandlers(container);
    await worker.broker.assertExchange(worker.env.RABBITMQ_EXCHANGE);
    const consumers = new EventConsumerHost(worker.broker, worker.db, logger, worker.env);
    for (const handler of handlers) await consumers.start(handler);
    drainer = new OutboxDrainer(worker.db.knex, worker.broker, worker.clock, logger, {
      exchange: worker.env.RABBITMQ_EXCHANGE,
      batchSize: worker.env.OUTBOX_BATCH_SIZE,
      maxBackoffMs: worker.env.OUTBOX_MAX_BACKOFF_MS,
    });
  });
  afterAll(async () => {
    await closeInfrastructure(worker);
    await t.close();
  });

  describe('projections', () => {
    it('apply newer versions only: an older or repeated event never rolls a rating back', async () => {
      const { productId, sellerId } = await api.listedVariant();
      const at = (version: number, count: number, sum: number) =>
        ratingEvent({ id: productId, count, sum, version }, { id: sellerId, count, sum, version });

      await apply(at(1, 1, 5));
      await apply(at(3, 3, 13));
      await apply(at(2, 2, 9)); // late
      await apply(at(3, 1, 1)); // a repeat of version 3 with other numbers: still ignored
      expect(await productRating(productId)).toEqual({
        rating_count: 3,
        rating_avg: '4.33',
        rating_version: '3',
      });
      expect(await sellerRating(sellerId)).toEqual({
        rating_count: 3,
        rating_avg: '4.33',
        rating_version: '3',
      });

      // Back to no reviews: the average is null again.
      await apply(at(4, 0, 0));
      expect(await productRating(productId)).toEqual({
        rating_count: 0,
        rating_avg: null,
        rating_version: '4',
      });
    });

    it('a malformed payload is permanent (the DLQ)', async () => {
      const { productId, sellerId } = await api.listedVariant();
      const bad = ratingEvent(
        { id: productId, count: 2, sum: 11, version: 1 },
        { id: sellerId, count: 2, sum: 11, version: 1 },
      );
      await expect(apply(bad)).rejects.toBeInstanceOf(PermanentEventError);
      const missing = { ...bad, payload: { product: { productId } } };
      await expect(apply(missing)).rejects.toBeInstanceOf(PermanentEventError);
    });

    it('end to end: a review reaches the product and seller rows, and both notifications, through the worker', async () => {
      const listed = await api.listedVariant();
      const buyer = await api.customer();
      const orderId = await api.fx.insertOrder(buyer.customerId);
      const sellerOrderId = await api.fx.insertSellerOrder(orderId, listed.sellerId, {
        status: 'delivered',
        delivered_at: new Date(Date.now() - DAY_MS),
      });
      const orderItemId = await api.fx.insertOrderItem(sellerOrderId, listed);
      const res = await request(t.app)
        .post(`${API}/reviews`)
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({ orderItemId, rating: 4 });
      expect(res.status).toBe(201);

      await drainer.drainOnce();
      await waitFor(async () => (await productRating(listed.productId))?.rating_count === 1, 10_000);
      await waitFor(async () => (await sellerRating(listed.sellerId))?.rating_count === 1, 10_000);
      expect(await productRating(listed.productId)).toMatchObject({
        rating_avg: '4.00',
        rating_version: '1',
      });

      // The seller hears of the review, the reviewer of the reply (spec 13 §8.8, NO-32).
      const reviewId = (res.body as { data: { id: string } }).data.id;
      const sellerUser = await knex()('sellers')
        .where({ id: listed.sellerId })
        .first<{ user_id: string }>('user_id');
      const notificationsOf = (userId: string) =>
        knex()('user_notifications')
          .where({ user_id: userId })
          .select<{ type: string; link: string }[]>('type', 'link');
      await waitFor(async () => (await notificationsOf(sellerUser?.user_id ?? '')).length > 0, 10_000);
      expect(await notificationsOf(sellerUser?.user_id ?? '')).toEqual([
        { type: 'review_received', link: '/seller/reviews' },
      ]);
      const reply = await request(t.app)
        .post(`${API}/seller/reviews/${reviewId}/reply`)
        .set('Authorization', `Bearer ${listed.sellerToken}`)
        .send({ body: 'Thank you!' });
      expect(reply.status).toBe(201);
      await drainer.drainOnce();
      await waitFor(async () => (await notificationsOf(buyer.userId)).length > 0, 10_000);
      expect(await notificationsOf(buyer.userId)).toEqual([
        { type: 'review_replied', link: `/me/reviews/${reviewId}` },
      ]);
    });
  });

  describe('public reads', () => {
    it('products: rating on list and detail; rating[gte] filters, -rating sorts with unrated last', async () => {
      const { sellerId } = await api.fx.insertSeller();
      const categoryId = await api.fx.insertCategory();
      const product = async (avg: string | null, count: number) => {
        const id = await api.fx.insertProduct(sellerId, categoryId, {
          status: 'active',
          published_at: new Date(),
          min_price: '10.00',
          max_price: '10.00',
          in_stock: true,
          rating_count: count,
          rating_avg: avg,
        });
        const variantId = await api.fx.insertVariant(id, sellerId, { price: '10.00' });
        await api.fx.insertInventoryItem(variantId, 5, 0);
        return id;
      };
      const best = await product('4.80', 10);
      const unrated = await product(null, 0);
      const good = await product('3.50', 2);
      await knex()('sellers')
        .where({ id: sellerId })
        .update({ rating_count: 12, rating_avg: '4.58', rating_version: '1' });

      const list = (query: string) =>
        request(t.app).get(`${API}/products?categoryId[eq]=${categoryId}${query}`);
      const ids = async (query: string) =>
        successBody<{ id: string }[]>(await list(query)).data.map((p) => p.id);
      expect(await ids('&sort=-rating')).toEqual([best, good, unrated]);
      expect(await ids('&sort=rating')).toEqual([unrated, good, best]);
      expect(await ids('&rating[gte]=4')).toEqual([best]);
      // Keyset pages on the rating sort.
      const first = await list('&sort=-rating&limit=2');
      const cursor = successBody<unknown[]>(first).meta?.nextCursor ?? '';
      expect(
        successBody<{ id: string }[]>(await list(`&sort=-rating&limit=2&cursor=${cursor}`)).data.map(
          (p) => p.id,
        ),
      ).toEqual([unrated]);
      const item = successBody<{ id: string; rating: unknown }[]>(await list('&sort=-rating')).data[0];
      expect(item?.rating).toEqual({ avg: '4.80', count: 10 });
      for (const bad of ['&rating[gte]=6', '&rating[gte]=0', '&rating[lte]=3']) {
        const res = await list(bad);
        expect(res.status, bad).toBe(400);
        expect(errorBody(res).error.code).toBe('INVALID_QUERY');
      }

      const detail = successBody<{ rating: unknown; seller: unknown }>(
        await request(t.app).get(`${API}/products/${best}`),
      ).data;
      expect(detail.rating).toEqual({ avg: '4.80', count: 10 });
      expect(detail.seller).toMatchObject({ id: sellerId, ratingAvg: '4.58', ratingCount: 12 });
    });

    it('GET /sellers/:sellerId: an approved seller page with its rating; any other status is 404', async () => {
      const approved = await api.fx.insertSeller('approved');
      await knex()('sellers')
        .where({ id: approved.sellerId })
        .update({ rating_count: 4, rating_avg: '3.75', rating_version: '2' });
      const res = await request(t.app).get(`${API}/sellers/${approved.sellerId}`);
      expect(res.status).toBe(200);
      expect(successBody(res).data).toEqual({
        id: approved.sellerId,
        businessName: expect.any(String) as unknown,
        ratingAvg: '3.75',
        ratingCount: 4,
        memberSince: expect.any(String) as unknown,
      });
      for (const status of ['pending_approval', 'suspended']) {
        const other = await api.fx.insertSeller(status);
        const missing = await request(t.app).get(`${API}/sellers/${other.sellerId}`);
        expect(missing.status, status).toBe(404);
        expect(errorBody(missing).error.code).toBe('SELLER_NOT_FOUND');
      }
      expect((await request(t.app).get(`${API}/sellers/not-a-uuid`)).status).toBe(400);
    });
  });
});
