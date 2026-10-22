import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IInventoryService } from '../../src/app/inventory';
import { type IOrderReturns, type ReturnAmounts } from '../../src/app/ordering';
import { type ITransactionRunner } from '../../src/lib/db';
import { TOKENS } from '../../src/lib/di';
import { AppError } from '../../src/lib/error';
import { successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { orderFixtures } from '../helpers/order-fixtures';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

const strings = (amounts: ReturnAmounts) =>
  Object.fromEntries(
    Object.entries(amounts).map(([key, value]) => [key, (value as { toString(): string }).toString()]),
  );

/** Runs `fn` and returns the AppError code and details it throws. */
async function appFailure(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AppError)
      return { code: error.code, status: error.httpStatus, details: error.details };
    throw error;
  }
  throw new Error('expected an AppError');
}

/*
 * Ordering's returns API (spec 09 §8.7, OR-27…OR-29) and inventory's restock (spec 07 §8) on real
 * Postgres: the returnable items, the quote, the logistics snapshots, recording returns under the order
 * lock, and the returned sums in the order views.
 */
describe('ordering returns API and inventory restock', () => {
  let t: TestApp;
  let fx: ReturnType<typeof orderFixtures>;
  let returns: IOrderReturns;
  let inventory: IInventoryService;
  let tx: ITransactionRunner;
  const knex = () => t.infra.db.knex;

  /**
   * A delivered COD seller order at 15 % commission: line A 3 × 33.33 with 1 cancelled (66.66), line B
   * 2 × 50.00 (100.00). Subtotal 166.66, commission round(24.999) = 25.00, net 141.66.
   */
  async function delivered(options: { status?: string } = {}) {
    const { customerId, userId } = await fx.insertCustomer();
    const { sellerId, sellerUserId, productId, variantId } = await fx.insertVariantChain();
    const variantB = await fx.insertVariant(productId, sellerId);
    const orderId = await fx.insertOrder(customerId);
    const status = options.status ?? 'delivered';
    const sellerOrderId = await fx.insertSellerOrder(orderId, sellerId, {
      status,
      subtotal: '166.66',
      commission_rate: '0.1500',
      commission: '25.00',
      seller_net: '141.66',
      delivered_at: status === 'delivered' ? new Date() : null,
    });
    const itemA = await fx.insertOrderItem(
      sellerOrderId,
      { variantId, productId },
      { unit_price: '33.33', quantity: 3, cancelled_quantity: 1, line_total: '66.66' },
    );
    const itemB = await fx.insertOrderItem(
      sellerOrderId,
      { variantId: variantB, productId },
      { unit_price: '50.00', quantity: 2, line_total: '100.00' },
    );
    await fx.insertPayment(orderId);
    return {
      customerId,
      userId,
      sellerId,
      sellerUserId,
      orderId,
      sellerOrderId,
      itemA,
      itemB,
      variantId,
      variantB,
    };
  }
  type Delivered = Awaited<ReturnType<typeof delivered>>;

  /** A return row for the deferred FK of order_item_returns (returns writes it in R2-P6 step 4). */
  async function insertReturn(d: Delivered): Promise<string> {
    const [row] = await knex()('return_requests')
      .insert({
        return_number: knex().raw(`'R-' || lpad(nextval('return_number_seq')::text, 9, '0')`),
        seller_order_id: d.sellerOrderId,
        order_id: d.orderId,
        customer_id: d.customerId,
        seller_id: d.sellerId,
        // Terminal, so several rows may exist for one seller order (uq_return_requests_seller_order_id_open).
        status: 'cancelled',
        reason: 'damaged',
        description: null,
        return_fee: '50.00',
        return_fee_payer: 'seller',
        agent_share_rate: '0.7000',
        refund_amount: '0.00',
        refund_payout_method: null,
        refund_payout_encrypted: null,
        seller_decision_deadline_at: new Date(Date.now() + 86_400_000),
      })
      .returning<{ id: string }[]>('id');
    if (!row) throw new Error('fixture');
    return row.id;
  }

  const record = async (d: Delivered, lines: { orderItemId: string; quantity: number }[]) => {
    const returnId = await insertReturn(d);
    return tx.run((trx) => returns.recordReturn({ sellerOrderId: d.sellerOrderId, returnId, lines }, trx));
  };

  beforeAll(async () => {
    t = await startTestApp();
    fx = orderFixtures(knex());
    returns = t.container.resolve<IOrderReturns>(TOKENS.OrderReturns);
    inventory = t.container.resolve<IInventoryService>(TOKENS.InventoryService);
    tx = t.container.resolve<ITransactionRunner>(TOKENS.TransactionRunner);
  });
  afterAll(async () => {
    await t.close();
  });

  describe('getReturnableItems', () => {
    it('lists the kept units at the unit price, with what returns needs of the seller order', async () => {
      const d = await delivered();
      const view = await returns.getReturnableItems(d.customerId, d.sellerOrderId);
      expect(view).toMatchObject({
        sellerOrderId: d.sellerOrderId,
        orderId: d.orderId,
        status: 'delivered',
        paymentMethod: 'cod',
        dropoffGovernorateId: await fx.governorateId(),
      });
      expect(view?.orderNumber).toMatch(/^NM-/);
      expect(view?.deliveredAt).toBeInstanceOf(Date);
      expect(view?.items.map((i) => [i.orderItemId, i.returnable, i.paidUnitAmount.toString()])).toEqual([
        [d.itemA, 2, '33.33'],
        [d.itemB, 2, '50.00'],
      ]);
    });

    it('is null for another customer or an unknown seller order, and leaves fully returned lines out', async () => {
      const d = await delivered();
      const other = await fx.insertCustomer();
      expect(await returns.getReturnableItems(other.customerId, d.sellerOrderId)).toBeNull();
      expect(await returns.getReturnableItems(d.customerId, UNKNOWN_ID)).toBeNull();
      await record(d, [{ orderItemId: d.itemB, quantity: 2 }]);
      const view = await returns.getReturnableItems(d.customerId, d.sellerOrderId);
      expect(view?.items.map((i) => i.orderItemId)).toEqual([d.itemA]);
    });
  });

  describe('quoteReturn', () => {
    it('applies the amount rule without writing anything', async () => {
      const d = await delivered();
      const amounts = await returns.quoteReturn(d.sellerOrderId, [{ orderItemId: d.itemA, quantity: 1 }]);
      // kept 166.66 → 133.33: commission 25.00 − round(19.9995) 20.00
      expect(strings(amounts)).toEqual({
        itemsSubtotal: '33.33',
        itemsPaid: '33.33',
        commissionReversed: '5.00',
        sellerNetReversed: '28.33',
        platformDiscountReversed: '0.00',
      });
      const [item] = await knex()('order_items')
        .where({ id: d.itemA })
        .select<{ returned_quantity: number }[]>('returned_quantity');
      expect(item).toEqual({ returned_quantity: 0 });
    });

    it('refuses quantities over the kept units, foreign lines and an empty list (422, OR-28)', async () => {
      const d = await delivered();
      const other = await delivered();
      const failure = await appFailure(() =>
        returns.quoteReturn(d.sellerOrderId, [
          { orderItemId: d.itemA, quantity: 3 },
          { orderItemId: other.itemA, quantity: 1 },
        ]),
      );
      expect(failure.code).toBe('RETURN_QUANTITY_INVALID');
      expect(failure.status).toBe(422);
      expect(failure.details?.map((detail) => [detail.value, detail.constraint])).toEqual([
        [d.itemA, 'returnable'],
        [other.itemA, 'part_of_seller_order'],
      ]);
      expect((await appFailure(() => returns.quoteReturn(d.sellerOrderId, []))).code).toBe(
        'RETURN_QUANTITY_INVALID',
      );
      expect((await appFailure(() => returns.quoteReturn(UNKNOWN_ID, []))).code).toBe(
        'SELLER_ORDER_NOT_FOUND',
      );
    });
  });

  it('getReturnLogistics: pickup is the order drop-off, drop-off the seller with its live name', async () => {
    const d = await delivered();
    await knex()('sellers').where({ id: d.sellerId }).update({ business_name: 'Nile Crafts Renamed' });
    const logistics = await returns.getReturnLogistics(d.sellerOrderId);
    expect(logistics?.pickup).toMatchObject({
      recipientName: 'Mona Ali',
      street: 'Road 9',
      governorateName: 'Cairo',
    });
    expect(logistics?.dropoff).toMatchObject({
      businessName: 'Nile Crafts Renamed',
      phone: '+201221234567',
      street: 'Street',
    });
    expect(await returns.getReturnLogistics(UNKNOWN_ID)).toBeNull();
  });

  describe('recordReturn', () => {
    it('records several partial returns that add up exactly to the delivered amounts', async () => {
      const d = await delivered();
      const first = await record(d, [
        { orderItemId: d.itemB, quantity: 1 },
        { orderItemId: d.itemA, quantity: 1 },
      ]);
      const second = await record(d, [{ orderItemId: d.itemA, quantity: 1 }]);
      const third = await record(d, [{ orderItemId: d.itemB, quantity: 1 }]);
      for (const amounts of [first, second, third]) {
        expect(amounts.sellerNetReversed.plus(amounts.commissionReversed).equals(amounts.itemsSubtotal)).toBe(
          true,
        );
      }

      const sellerOrder = await knex()('seller_orders')
        .where({ id: d.sellerOrderId })
        .first<Record<string, string> | undefined>(
          'status',
          'subtotal',
          'commission',
          'returned_subtotal',
          'returned_paid',
          'returned_commission',
          'returned_seller_net',
        );
      expect(sellerOrder).toEqual({
        status: 'delivered',
        subtotal: '166.66',
        commission: '25.00',
        returned_subtotal: '166.66',
        returned_paid: '166.66',
        returned_commission: '25.00',
        returned_seller_net: '141.66',
      });
      const items = await knex()('order_items')
        .whereIn('id', [d.itemA, d.itemB])
        .orderBy('unit_price')
        .select('quantity', 'cancelled_quantity', 'returned_quantity', 'line_total');
      expect(items).toEqual([
        { quantity: 3, cancelled_quantity: 1, returned_quantity: 2, line_total: '66.66' },
        { quantity: 2, cancelled_quantity: 0, returned_quantity: 2, line_total: '100.00' },
      ]);
      const rows = await knex()('order_item_returns')
        .whereIn('order_item_id', [d.itemA, d.itemB])
        .select<Record<string, string>[]>(
          'quantity',
          'subtotal_amount',
          'discount_amount',
          'paid_amount',
          'commission_amount',
        );
      expect(rows).toHaveLength(4);
      const sum = (key: string) =>
        rows.reduce((total, row) => total + Math.round(Number(row[key]) * 100), 0) / 100;
      expect([
        sum('subtotal_amount'),
        sum('paid_amount'),
        sum('commission_amount'),
        sum('discount_amount'),
      ]).toEqual([166.66, 166.66, 25, 0]);
    });

    it('re-checks the quantities under the order lock: of two parallel returns of the last units, one wins', async () => {
      const d = await delivered();
      const results = await Promise.allSettled([
        record(d, [{ orderItemId: d.itemB, quantity: 2 }]),
        record(d, [{ orderItemId: d.itemB, quantity: 2 }]),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [rejected] = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect((rejected?.reason as AppError).code).toBe('RETURN_QUANTITY_INVALID');
      const [item] = await knex()('order_items')
        .where({ id: d.itemB })
        .select<{ returned_quantity: number }[]>('returned_quantity');
      expect(item).toEqual({ returned_quantity: 2 });
      expect(await knex()('order_item_returns').where({ order_item_id: d.itemB })).toHaveLength(1);
    });

    it('treats a seller order that is not delivered as a caller bug and writes nothing', async () => {
      const d = await delivered({ status: 'placed' });
      await expect(record(d, [{ orderItemId: d.itemB, quantity: 1 }])).rejects.toThrow(/not delivered/);
      expect(await knex()('order_item_returns').where({ order_item_id: d.itemB })).toHaveLength(0);
    });
  });

  it('order views show the returned units and sums; itemCount counts kept units (OR-9)', async () => {
    const d = await delivered();
    await record(d, [{ orderItemId: d.itemB, quantity: 1 }]);
    const customer = await signTestAccessToken({ sub: d.userId, role: 'customer' });
    const seller = await signTestAccessToken({ sub: d.sellerUserId, role: 'seller' });
    const get = (path: string, token: string) =>
      request(t.app).get(`${API}${path}`).set('Authorization', `Bearer ${token}`).expect(200);

    const detail = successBody<{
      sellerOrders: { returnedPaid: string; items: { id: string; returnedQuantity: number }[] }[];
    }>(await get(`/orders/${d.orderId}`, customer)).data;
    expect(detail.sellerOrders[0]?.returnedPaid).toBe('50.00');
    expect(detail.sellerOrders[0]?.items.map((i) => [i.id, i.returnedQuantity])).toEqual([
      [d.itemA, 0],
      [d.itemB, 1],
    ]);
    expect(detail.sellerOrders[0]).not.toHaveProperty('returnedCommission');

    const list = successBody<{ id: string; itemCount: number }[]>(await get('/orders', customer)).data;
    expect(list.find((o) => o.id === d.orderId)?.itemCount).toBe(3);

    const sellerView = successBody<Record<string, string>>(
      await get(`/seller/orders/${d.sellerOrderId}`, seller),
    ).data;
    // kept 166.66 → 116.66: commission 25.00 − round(17.499) 17.50
    expect([
      sellerView.returnedSubtotal,
      sellerView.returnedCommission,
      sellerView.returnedSellerNet,
    ]).toEqual(['50.00', '7.50', '42.50']);
  });

  describe('inventory.restock (spec 07 §8)', () => {
    it('puts units back on hand with one return_restock movement per item and return', async () => {
      const d = await delivered();
      await fx.insertInventoryItem(d.variantId, 0, 0);
      await fx.insertInventoryItem(d.variantB, 4, 4);
      const returnId = randomUUID();
      await tx.run((trx) =>
        inventory.restock(
          [
            { variantId: d.variantB, quantity: 1, returnId },
            { variantId: d.variantId, quantity: 1, returnId },
            { variantId: d.variantId, quantity: 1, returnId },
          ],
          d.sellerUserId,
          trx,
        ),
      );
      const stock = await inventory.getStockByVariantIds([d.variantId, d.variantB]);
      expect(Object.fromEntries(stock.map((s) => [s.variantId, [s.onHand, s.reserved]]))).toEqual({
        [d.variantId]: [2, 0],
        [d.variantB]: [5, 4],
      });
      const movements = await knex()('inventory_movements as m')
        .join('inventory_items as i', 'i.id', 'm.inventory_item_id')
        .whereIn('i.variant_id', [d.variantId, d.variantB])
        .orderBy('i.variant_id')
        .select<Record<string, unknown>[]>(
          'i.variant_id',
          'm.type',
          'm.quantity_delta',
          'm.on_hand_after',
          'm.reference_type',
          'm.reference_id',
          'm.actor_user_id',
        );
      expect(movements).toHaveLength(2);
      for (const movement of movements) {
        expect(movement).toMatchObject({
          type: 'return_restock',
          reference_type: 'return',
          reference_id: returnId,
          actor_user_id: d.sellerUserId,
        });
      }
      expect(movements.find((m) => m.variant_id === d.variantId)).toMatchObject({
        quantity_delta: 2,
        on_hand_after: 2,
      });

      // Sellable crossed 0 for both: 0 → 2 and 0 → 1.
      const events = await knex()('events_outbox')
        .where({ event_type: 'inventory.stock_status_changed' })
        .whereRaw(`payload->>'variantId' = ANY(?)`, [[d.variantId, d.variantB]])
        .select<{ payload: { inStock: boolean } }[]>('payload');
      expect(events.map((e) => e.payload.inStock)).toEqual([true, true]);
    });

    it('needs a stock row (a bug otherwise) and does nothing for an empty list', async () => {
      const d = await delivered();
      await tx.run((trx) => inventory.restock([], null, trx));
      expect(
        (
          await appFailure(() =>
            tx.run((trx) =>
              inventory.restock([{ variantId: d.variantId, quantity: 1, returnId: randomUUID() }], null, trx),
            ),
          )
        ).code,
      ).toBe('INVENTORY_ITEM_NOT_FOUND');
    });
  });
});
