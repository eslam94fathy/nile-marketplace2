import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ICustomerDirectory } from '../../src/app/customers';
import { type IDeliveryAgentDirectory } from '../../src/app/delivery';
import { type IOrderingDirectory } from '../../src/app/ordering';
import { type ISellerDirectory } from '../../src/app/sellers';
import { TOKENS } from '../../src/lib/di';
import { deliveryFixtures } from '../helpers/delivery-fixtures';
import { orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/*
 * Spec 09 §8.1 (ordering's public API for realtime, notifications and support) and the profile → user
 * id lookups of customers, sellers and delivery (spec 02 §6.3), on real Postgres.
 */
describe('ordering directory and recipient lookups', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let ordering: IOrderingDirectory;

  /** One buyer, two sellers: a seller order each. */
  async function twoSellerOrder() {
    const buyer = await api.customer();
    const a = await api.listedVariant({ price: '100.00' });
    const b = await api.listedVariant({ price: '40.00' });
    const { order } = await api.placeOrder(
      buyer,
      [
        { variantId: a.variantId, quantity: 1 },
        { variantId: b.variantId, quantity: 1 },
      ],
      '190.00',
    );
    const soA = must(order.sellerOrders.find((s) => s.sellerId === a.sellerId));
    const soB = must(order.sellerOrders.find((s) => s.sellerId === b.sellerId));
    return { buyer, a, b, order, soA, soB };
  }

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
    ordering = t.container.resolve<IOrderingDirectory>(TOKENS.OrderingDirectory);
  });
  afterAll(async () => {
    await t.close();
  });

  describe('getNotificationParties', () => {
    it('by order id or by seller order id: each order once, with all its seller orders and live statuses', async () => {
      const { buyer, a, b, order, soA, soB } = await twoSellerOrder();
      const party = {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerId: buyer.customerId,
        status: 'placed',
        sellerOrders: expect.arrayContaining([
          { sellerOrderId: soA.id, sellerId: a.sellerId, status: 'placed' },
          { sellerOrderId: soB.id, sellerId: b.sellerId, status: 'placed' },
        ]) as unknown,
      };
      expect(await ordering.getNotificationParties({ orderIds: [order.id] })).toEqual([party]);
      // Both seller orders and the order itself name the same order: still one party.
      const viaSellerOrders = await ordering.getNotificationParties({
        orderIds: [order.id],
        sellerOrderIds: [soA.id, soB.id],
      });
      expect(viaSellerOrders).toEqual([party]);
      expect(must(viaSellerOrders[0]).sellerOrders).toHaveLength(2);

      // Re-read, not from a payload: the status after the seller accepts.
      expect((await api.as(a.sellerToken).post(`/seller/orders/${soA.id}/accept`)).status).toBe(200);
      const [after] = await ordering.getNotificationParties({ sellerOrderIds: [soA.id] });
      expect(after?.status).toBe('in_progress');
      expect(after?.sellerOrders.find((s) => s.sellerOrderId === soA.id)?.status).toBe('accepted');
    });

    it('unknown ids are left out; nothing asked → nothing returned', async () => {
      const { order } = await twoSellerOrder();
      expect(
        (
          await ordering.getNotificationParties({
            orderIds: [order.id, UNKNOWN_ID],
            sellerOrderIds: [UNKNOWN_ID],
          })
        ).map((p) => p.orderId),
      ).toEqual([order.id]);
      expect(await ordering.getNotificationParties({})).toEqual([]);
    });
  });

  describe('getCustomerOrderLink / getSellerOrderLink / getOrderNumbers', () => {
    it('a customer links their own order, optionally with one of its seller orders', async () => {
      const { buyer, order, soA } = await twoSellerOrder();
      expect(await ordering.getCustomerOrderLink(buyer.customerId, order.id)).toEqual({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sellerOrderId: null,
      });
      expect(await ordering.getCustomerOrderLink(buyer.customerId, order.id, soA.id)).toEqual({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sellerOrderId: soA.id,
      });
    });

    it("null for another customer's order, an unknown order, or a seller order of another order", async () => {
      const first = await twoSellerOrder();
      const second = await twoSellerOrder();
      expect(await ordering.getCustomerOrderLink(second.buyer.customerId, first.order.id)).toBeNull();
      expect(await ordering.getCustomerOrderLink(first.buyer.customerId, UNKNOWN_ID)).toBeNull();
      expect(
        await ordering.getCustomerOrderLink(first.buyer.customerId, first.order.id, second.soA.id),
      ).toBeNull();
      expect(
        await ordering.getCustomerOrderLink(first.buyer.customerId, first.order.id, UNKNOWN_ID),
      ).toBeNull();
    });

    it("a seller links its own seller order; null for another seller's, an unknown one or pending_payment", async () => {
      const { a, b, order, soA } = await twoSellerOrder();
      expect(await ordering.getSellerOrderLink(a.sellerId, soA.id)).toEqual({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sellerOrderId: soA.id,
      });
      expect(await ordering.getSellerOrderLink(b.sellerId, soA.id)).toBeNull();
      expect(await ordering.getSellerOrderLink(a.sellerId, UNKNOWN_ID)).toBeNull();
      await t.infra.db.knex('seller_orders').where({ id: soA.id }).update({ status: 'pending_payment' });
      expect(await ordering.getSellerOrderLink(a.sellerId, soA.id)).toBeNull();
    });

    it('order numbers in one batch, unknown ids left out', async () => {
      const first = await twoSellerOrder();
      const second = await twoSellerOrder();
      expect(await ordering.getOrderNumbers([first.order.id, second.order.id, UNKNOWN_ID])).toEqual(
        new Map([
          [first.order.id, first.order.orderNumber],
          [second.order.id, second.order.orderNumber],
        ]),
      );
      expect(await ordering.getOrderNumbers([])).toEqual(new Map());
    });
  });

  describe('getUserIds (customers, sellers, delivery)', () => {
    it('maps each known profile id to its user id in one batch, unknown ids left out', async () => {
      const { buyer, a, b } = await twoSellerOrder();
      const customers = t.container.resolve<ICustomerDirectory>(TOKENS.CustomerDirectory);
      const sellers = t.container.resolve<ISellerDirectory>(TOKENS.SellerDirectory);
      const agents = t.container.resolve<IDeliveryAgentDirectory>(TOKENS.DeliveryAgentDirectory);
      const agent = await deliveryFixtures(t.infra.db.knex).insertAgent();

      expect(await customers.getUserIds([buyer.customerId, UNKNOWN_ID])).toEqual(
        new Map([[buyer.customerId, buyer.userId]]),
      );
      expect(await sellers.getUserIds([a.sellerId, b.sellerId, UNKNOWN_ID])).toEqual(
        new Map([
          [a.sellerId, a.sellerUserId],
          [b.sellerId, b.sellerUserId],
        ]),
      );
      expect(await agents.getUserIds([agent.agentId, UNKNOWN_ID])).toEqual(
        new Map([[agent.agentId, agent.userId]]),
      );
      for (const directory of [customers, sellers, agents])
        expect(await directory.getUserIds([])).toEqual(new Map());
    });
  });
});
