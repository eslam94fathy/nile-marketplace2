import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ICatalogDirectory } from '../../src/app/catalog';
import { type ICustomerDirectory } from '../../src/app/customers';
import { type IOrderingDirectory } from '../../src/app/ordering';
import { TOKENS } from '../../src/lib/di';
import { attachProductImage } from '../helpers/media';
import { orderFixtures } from '../helpers/order-fixtures';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';
const DAY_MS = 86_400_000;

/*
 * The lookups spec 17 reads through other modules' public APIs, on real Postgres: ordering's reviewable
 * items (spec 09 §8.1, OR-26), customers' reviewer names (spec 04 §8.3, RV-6) and catalog's product
 * cards and visibility (spec 06 §9.3).
 */
describe('review lookups in ordering, customers and catalog', () => {
  let t: TestApp;
  let fx: ReturnType<typeof orderFixtures>;
  let ordering: IOrderingDirectory;
  const knex = () => t.infra.db.knex;

  /**
   * A customer's order with one seller order delivered `daysAgo` days ago and its items. Items are
   * 2 × 50.00; `cancelled` is 0 or 2 (the whole line).
   */
  async function deliveredOrder(
    customerId: string,
    items: { cancelled?: number }[] = [{}],
    daysAgo = 1,
    status = 'delivered',
  ) {
    const { sellerId, productId, variantId } = await fx.insertVariantChain();
    const orderId = await fx.insertOrder(customerId);
    const sellerOrderId = await fx.insertSellerOrder(orderId, sellerId, {
      status,
      delivered_at: status === 'delivered' ? new Date(Date.now() - daysAgo * DAY_MS) : null,
    });
    const itemIds = [];
    for (const item of items) {
      itemIds.push(
        await fx.insertOrderItem(
          sellerOrderId,
          { variantId, productId },
          {
            cancelled_quantity: item.cancelled ?? 0,
            // Less the cancelled units (chk_order_items_line_total).
            line_total: item.cancelled === 2 ? '0.00' : '100.00',
          },
        ),
      );
    }
    return { orderId, sellerOrderId, sellerId, productId, variantId, itemIds };
  }

  beforeAll(async () => {
    t = await startTestApp();
    fx = orderFixtures(knex());
    ordering = t.container.resolve<IOrderingDirectory>(TOKENS.OrderingDirectory);
  });
  afterAll(async () => {
    await t.close();
  });

  describe('ordering', () => {
    it('getReviewableItem: a delivered item of the customer with its attributes; null otherwise', async () => {
      const { customerId } = await fx.insertCustomer();
      const other = await fx.insertCustomer();
      const delivered = await deliveredOrder(customerId, [{ cancelled: 2 }, {}]);
      const placed = await deliveredOrder(customerId, [{}], 0, 'out_for_delivery');
      const [fullyCancelled, open] = delivered.itemIds;

      expect(await ordering.getReviewableItem(customerId, open ?? '')).toEqual({
        orderItemId: open,
        orderId: delivered.orderId,
        productId: delivered.productId,
        variantId: delivered.variantId,
        sellerId: delivered.sellerId,
        deliveredAt: expect.any(Date) as unknown,
        openQuantity: 2,
        attributes: [{ attribute: 'Color', value: 'Black' }],
      });
      // A fully cancelled item comes back with nothing open: reviews refuses it (REVIEW_NOT_ALLOWED).
      expect((await ordering.getReviewableItem(customerId, fullyCancelled ?? ''))?.openQuantity).toBe(0);
      expect(await ordering.getReviewableItem(other.customerId, open ?? '')).toBeNull();
      expect(await ordering.getReviewableItem(customerId, placed.itemIds[0] ?? '')).toBeNull();
      expect(await ordering.getReviewableItem(customerId, UNKNOWN_ID)).toBeNull();
    });

    it('listDeliveredItems: open items since the cutoff, newest delivery first, excluded products out, full pages', async () => {
      const { customerId } = await fx.insertCustomer();
      const oldest = await deliveredOrder(customerId, [{}], 5);
      const middle = await deliveredOrder(customerId, [{}, { cancelled: 2 }], 3);
      const newest = await deliveredOrder(customerId, [{}], 1);
      const reviewed = await deliveredOrder(customerId, [{}], 2);
      await deliveredOrder(customerId, [{}], 90); // outside the window
      await deliveredOrder((await fx.insertCustomer()).customerId, [{}], 1); // another customer
      const base = {
        deliveredAfter: new Date(Date.now() - 60 * DAY_MS),
        excludeProductIds: [reviewed.productId],
        after: null,
        limit: 10,
      };

      const all = await ordering.listDeliveredItems(customerId, base);
      expect(all.map((item) => item.orderItemId)).toEqual([
        newest.itemIds[0],
        middle.itemIds[0],
        oldest.itemIds[0],
      ]);
      expect(all[0]).toMatchObject({
        productName: 'Phone',
        imageMediaId: null,
        orderNumber: expect.any(String) as unknown,
      });

      // Keyset pages of 1: the cursor carries a millisecond Date (D-19) and nothing repeats or skips.
      const pages: (string | undefined)[] = [];
      let after: { deliveredAt: Date; orderItemId: string } | null = null;
      for (;;) {
        const [item] = await ordering.listDeliveredItems(customerId, { ...base, after, limit: 1 });
        if (!item) break;
        pages.push(item.orderItemId);
        after = { deliveredAt: item.deliveredAt, orderItemId: item.orderItemId };
      }
      expect(pages).toEqual(all.map((item) => item.orderItemId));
    });
  });

  describe('customers', () => {
    it('getDisplayNames: first name and last initial ("Mona A."); unknown ids are left out', async () => {
      const customers = t.container.resolve<ICustomerDirectory>(TOKENS.CustomerDirectory);
      const { customerId } = await fx.insertCustomer();
      expect([...(await customers.getDisplayNames([customerId, UNKNOWN_ID]))]).toEqual([
        [customerId, 'Mona A.'],
      ]);
      expect(await customers.getDisplayNames([])).toEqual(new Map());
    });
  });

  describe('catalog', () => {
    it('getProductCards: visible and hidden products, deleted included, with rating and primary image', async () => {
      const catalog = t.container.resolve<ICatalogDirectory>(TOKENS.CatalogDirectory);
      const { sellerId } = await fx.insertSeller();
      const categoryId = await fx.insertCategory();
      const visible = await fx.insertProduct(sellerId, categoryId, {
        status: 'active',
        published_at: new Date(),
        min_price: '100.00',
        max_price: '120.00',
        in_stock: true,
        rating_count: 2,
        rating_avg: '4.50',
      });
      const draft = await fx.insertProduct(sellerId, categoryId);
      const deleted = await fx.insertProduct(sellerId, categoryId, {
        status: 'active',
        deleted_at: new Date(),
      });
      const seller = await knex()('sellers').where({ id: sellerId }).first<{ user_id: string }>('user_id');
      const mediaId = await attachProductImage(t, {
        productId: visible,
        ownerUserId: seller?.user_id ?? '',
        position: 0,
      });

      const cards = await catalog.getProductCards([visible, draft, deleted, UNKNOWN_ID]);
      expect(cards.size).toBe(3);
      expect(cards.get(visible)).toMatchObject({
        id: visible,
        minPrice: '100.00',
        maxPrice: '120.00',
        inStock: true,
        available: true,
        rating: { avg: '4.50', count: 2 },
        primaryImage: { id: mediaId },
      });
      expect(cards.get(draft)).toMatchObject({
        available: false,
        primaryImage: null,
        rating: { avg: null, count: 0 },
      });
      expect(cards.get(deleted)?.available).toBe(false);

      expect(await catalog.isPubliclyVisible(visible)).toBe(true);
      expect(await catalog.isPubliclyVisible(draft)).toBe(false);
      expect(await catalog.isPubliclyVisible(deleted)).toBe(false);
      expect(await catalog.isPubliclyVisible(UNKNOWN_ID)).toBe(false);
    });
  });
});
