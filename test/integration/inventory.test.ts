import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IInventoryService, INVENTORY_MOVEMENT_LIST_SPEC } from '../../src/app/inventory';
import { type ITransactionRunner } from '../../src/lib/db';
import { TOKENS } from '../../src/lib/di';
import { parseListQuery } from '../../src/lib/http';
import { catalogFixtures } from '../helpers/catalog-fixtures';
import { orderFixtures } from '../helpers/order-fixtures';
import { startTestApp, type TestApp } from '../helpers/test-app';

describe('inventory public API (spec 07, real Postgres)', () => {
  let t: TestApp;
  let inventory: IInventoryService;
  let tx: ITransactionRunner;
  let fx: ReturnType<typeof catalogFixtures>;
  let actor: string;

  const knex = () => t.infra.db.knex;
  const stockEvents = (variantId: string) =>
    knex()('events_outbox')
      .where({ event_type: 'inventory.stock_status_changed' })
      .whereRaw(`payload->>'variantId' = ?`, [variantId])
      .orderBy('id')
      .select<{ payload: { variantId: string; inStock: boolean } }[]>('payload');
  const movementsOf = (variantId: string) =>
    knex()('inventory_movements as m')
      .join('inventory_items as i', 'i.id', 'm.inventory_item_id')
      .where('i.variant_id', variantId)
      .orderBy('m.id')
      .select<{ type: string; quantity_delta: number; on_hand_after: number; actor_user_id: string }[]>(
        'm.type',
        'm.quantity_delta',
        'm.on_hand_after',
        'm.actor_user_id',
      );
  /** A variant with a stock row of `onHand`. */
  const stocked = async (onHand: number): Promise<string> => {
    const { variantId } = await fx.insertVariantChain();
    await tx.run((trx) => inventory.createItem(variantId, onHand, actor, trx));
    return variantId;
  };

  beforeAll(async () => {
    t = await startTestApp();
    inventory = t.container.resolve<IInventoryService>(TOKENS.InventoryService);
    tx = t.container.resolve<ITransactionRunner>(TOKENS.TransactionRunner);
    fx = catalogFixtures(knex());
    actor = await fx.insertUser('seller');
  });
  afterAll(async () => {
    await t.close();
  });

  it('createItem writes the row and a movement for positive stock; getStockByVariantIds is batched', async () => {
    const empty = await stocked(0);
    const full = await stocked(12);
    expect(await movementsOf(empty)).toEqual([]);
    expect(await movementsOf(full)).toEqual([
      { type: 'seller_adjustment', quantity_delta: 12, on_hand_after: 12, actor_user_id: actor },
    ]);
    expect(await stockEvents(full)).toEqual([]);

    const unknown = '01920d3e-7a1c-7c2b-9a4e-3f0c2d1b6a55';
    const stock = await inventory.getStockByVariantIds([empty, full, unknown, full]);
    expect(stock.sort((a, b) => a.onHand - b.onHand)).toEqual([
      { variantId: empty, onHand: 0, reserved: 0, sellable: 0 },
      { variantId: full, onHand: 12, reserved: 0, sellable: 12 },
    ]);
    expect(await inventory.getStockByVariantIds([])).toEqual([]);
  });

  it('createItem rolls back with the caller transaction', async () => {
    const { variantId } = await fx.insertVariantChain();
    await expect(
      tx.run(async (trx) => {
        await inventory.createItem(variantId, 5, actor, trx);
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');
    expect(await inventory.getStockByVariantIds([variantId])).toEqual([]);
    expect(await movementsOf(variantId)).toEqual([]);
  });

  it('adjust emits inventory.stock_status_changed only when sellable crosses 0', async () => {
    const variantId = await stocked(0);
    await tx.run((trx) => inventory.adjust(variantId, 5, actor, trx)); // 0 → 5: in stock
    await tx.run((trx) => inventory.adjust(variantId, -2, actor, trx)); // 5 → 3: no change
    const after = await tx.run((trx) => inventory.adjust(variantId, -3, actor, trx)); // 3 → 0: out
    expect(after).toEqual({ variantId, onHand: 0, reserved: 0, sellable: 0 });
    expect((await stockEvents(variantId)).map((e) => e.payload)).toEqual([
      { variantId, inStock: true },
      { variantId, inStock: false },
    ]);
    expect((await movementsOf(variantId)).map((m) => [m.quantity_delta, m.on_hand_after])).toEqual([
      [5, 5],
      [-2, 3],
      [-3, 0],
    ]);
  });

  it('adjust never takes on_hand below 0 or below reserved, and changes nothing when refused', async () => {
    const variantId = await stocked(5);
    await knex()('inventory_items').where({ variant_id: variantId }).update({ reserved: 4 });
    const adjust = (delta: number) => tx.run((trx) => inventory.adjust(variantId, delta, actor, trx));
    await expect(adjust(-2)).rejects.toMatchObject({ code: 'STOCK_ADJUSTMENT_INVALID' });
    await expect(adjust(-6)).rejects.toMatchObject({ code: 'STOCK_ADJUSTMENT_INVALID' });
    await expect(adjust(-1)).resolves.toEqual({ variantId, onHand: 4, reserved: 4, sellable: 0 });
    expect((await movementsOf(variantId)).map((m) => m.quantity_delta)).toEqual([5, -1]);
  });

  it('parallel decrements never oversell, and the crossing is emitted once', async () => {
    const variantId = await stocked(3);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => tx.run((trx) => inventory.adjust(variantId, -1, actor, trx))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(7);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: 'STOCK_ADJUSTMENT_INVALID' });
    expect((await inventory.getStockByVariantIds([variantId]))[0]?.onHand).toBe(0);
    expect((await stockEvents(variantId)).map((e) => e.payload.inStock)).toEqual([false]);
  });

  it('adjust on a variant without a stock row is an internal error', async () => {
    const { variantId } = await fx.insertVariantChain();
    await expect(tx.run((trx) => inventory.adjust(variantId, 1, actor, trx))).rejects.toMatchObject({
      code: 'INVENTORY_ITEM_NOT_FOUND',
      httpStatus: 500,
    });
  });

  it('listMovements pages newest first with no duplicates or gaps', async () => {
    const variantId = await stocked(1);
    for (const delta of [1, 2, 3, 4]) await tx.run((trx) => inventory.adjust(variantId, delta, actor, trx));
    const limits = { defaultLimit: 2, maxLimit: 100 };

    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = parseListQuery(cursor ? { cursor } : {}, INVENTORY_MOVEMENT_LIST_SPEC, limits);
      const page = await inventory.listMovements(variantId, query);
      seen.push(...page.items.map((m) => m.quantityDelta));
      cursor = page.meta.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([4, 3, 2, 1, 1]);
  });
});

describe('inventory reservations (spec 07 UC-IN-1…3, real Postgres)', () => {
  let t: TestApp;
  let inventory: IInventoryService;
  let tx: ITransactionRunner;
  let fx: ReturnType<typeof orderFixtures>;
  let actor: string;

  const knex = () => t.infra.db.knex;
  const stockOf = async (variantId: string) => (await inventory.getStockByVariantIds([variantId]))[0];
  const reservationOf = (orderItemId: string) =>
    knex()('inventory_reservations')
      .where({ order_item_id: orderItemId })
      .first<{ quantity: number; status: string } | undefined>('quantity', 'status');
  const stockEvents = async (variantId: string) =>
    (
      await knex()('events_outbox')
        .where({ event_type: 'inventory.stock_status_changed' })
        .whereRaw(`payload->>'variantId' = ?`, [variantId])
        .orderBy('id')
        .select<{ payload: { inStock: boolean } }[]>('payload')
    ).map((row) => row.payload.inStock);
  const movementsOf = (orderItemId: string) =>
    knex()('inventory_movements')
      .where({ reference_type: 'order_item', reference_id: orderItemId })
      .orderBy('id')
      .select<{ type: string; quantity_delta: number; on_hand_after: number; reserved_after: number }[]>(
        'type',
        'quantity_delta',
        'on_hand_after',
        'reserved_after',
      );

  /** `stocks.length` stocked variants, each with an order line in one seller order. */
  async function lines(...stocks: number[]): Promise<{ variantId: string; orderItemId: string }[]> {
    const chain = await fx.insertOrderChain();
    const result = [{ variantId: chain.variantId, orderItemId: chain.orderItemId }];
    for (let i = 1; i < stocks.length; i += 1) {
      const variantId = await fx.insertVariant(chain.productId, chain.sellerId);
      const orderItemId = await fx.insertOrderItem(chain.sellerOrderId, {
        variantId,
        productId: chain.productId,
      });
      result.push({ variantId, orderItemId });
    }
    for (const [i, line] of result.entries()) {
      await tx.run((trx) => inventory.createItem(line.variantId, stocks[i] ?? 0, actor, trx));
    }
    return result;
  }

  beforeAll(async () => {
    t = await startTestApp();
    inventory = t.container.resolve<IInventoryService>(TOKENS.InventoryService);
    tx = t.container.resolve<ITransactionRunner>(TOKENS.TransactionRunner);
    fx = orderFixtures(knex());
    actor = await fx.insertUser('seller');
  });
  afterAll(async () => {
    await t.close();
  });

  it('reserve holds stock per line, records reservations and movements, and emits when sellable reaches 0', async () => {
    const [a, b] = await lines(5, 2);
    if (!a || !b) throw new Error('fixture');
    await tx.run((trx) =>
      inventory.reserve(
        [
          { ...b, quantity: 2 },
          { ...a, quantity: 3 },
        ],
        trx,
      ),
    );
    expect(await stockOf(a.variantId)).toEqual({
      variantId: a.variantId,
      onHand: 5,
      reserved: 3,
      sellable: 2,
    });
    expect(await stockOf(b.variantId)).toEqual({
      variantId: b.variantId,
      onHand: 2,
      reserved: 2,
      sellable: 0,
    });
    expect(await reservationOf(a.orderItemId)).toEqual({ quantity: 3, status: 'active' });
    expect(await movementsOf(b.orderItemId)).toEqual([
      { type: 'reserve', quantity_delta: -2, on_hand_after: 2, reserved_after: 2 },
    ]);
    expect(await stockEvents(a.variantId)).toEqual([]);
    expect(await stockEvents(b.variantId)).toEqual([false]);
  });

  it('a short line rolls back the whole reservation and reports every short variant', async () => {
    const [a, b, c] = await lines(5, 1, 0);
    if (!a || !b || !c) throw new Error('fixture');
    const error = await tx
      .run((trx) =>
        inventory.reserve(
          [
            { ...a, quantity: 2 },
            { ...b, quantity: 2 },
            { ...c, quantity: 1 },
          ],
          trx,
        ),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'INSUFFICIENT_STOCK', httpStatus: 409 });
    expect((error as { details: unknown }).details).toEqual([
      { field: 'variantId', value: b.variantId, constraint: 'available', message: 'available: 1' },
      { field: 'variantId', value: c.variantId, constraint: 'available', message: 'available: 0' },
    ]);
    expect((await stockOf(a.variantId))?.reserved).toBe(0);
    expect(await reservationOf(a.orderItemId)).toBeUndefined();
    expect(await movementsOf(a.orderItemId)).toEqual([]);
  });

  it('two checkouts racing for the last unit: exactly one reserves it', async () => {
    const [first] = await lines(1);
    const [second] = await lines(0);
    if (!first || !second) throw new Error('fixture');
    const results = await Promise.allSettled(
      [first.orderItemId, second.orderItemId].map((orderItemId) =>
        tx.run((trx) => inventory.reserve([{ variantId: first.variantId, orderItemId, quantity: 1 }], trx)),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await stockOf(first.variantId)).toMatchObject({ onHand: 1, reserved: 1 });
  });

  it('parallel checkouts over the same variants in opposite line order do not deadlock', async () => {
    const [a, b] = await lines(50, 50);
    if (!a || !b) throw new Error('fixture');
    const orders = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const chain = await fx.insertOrderChain();
        const lineFor = async (variantId: string) =>
          fx.insertOrderItem(chain.sellerOrderId, { variantId, productId: chain.productId });
        return { a: await lineFor(a.variantId), b: await lineFor(b.variantId) };
      }),
    );
    await Promise.all(
      orders.map((order, i) => {
        const pair = [
          { variantId: a.variantId, orderItemId: order.a, quantity: 1 },
          { variantId: b.variantId, orderItemId: order.b, quantity: 1 },
        ];
        return tx.run((trx) => inventory.reserve(i % 2 === 0 ? pair : pair.reverse(), trx));
      }),
    );
    expect((await stockOf(a.variantId))?.reserved).toBe(6);
    expect((await stockOf(b.variantId))?.reserved).toBe(6);
  });

  it('release lowers the reservation, ends at released with 0, emits when back in stock, and replays are no-ops', async () => {
    const [line] = await lines(3);
    if (!line) throw new Error('fixture');
    await tx.run((trx) => inventory.reserve([{ ...line, quantity: 3 }], trx));
    await tx.run((trx) => inventory.release([{ orderItemId: line.orderItemId, quantity: 1 }], trx));
    expect(await reservationOf(line.orderItemId)).toEqual({ quantity: 2, status: 'active' });
    await tx.run((trx) => inventory.release([{ orderItemId: line.orderItemId, quantity: 2 }], trx));
    expect(await reservationOf(line.orderItemId)).toEqual({ quantity: 0, status: 'released' });
    await tx.run((trx) => inventory.release([{ orderItemId: line.orderItemId, quantity: 2 }], trx)); // replay

    expect(await stockOf(line.variantId)).toMatchObject({ onHand: 3, reserved: 0, sellable: 3 });
    expect(
      (await movementsOf(line.orderItemId)).map((m) => [m.type, m.quantity_delta, m.reserved_after]),
    ).toEqual([
      ['reserve', -3, 3],
      ['release', 1, 2],
      ['release', 2, 0],
    ]);
    expect(await stockEvents(line.variantId)).toEqual([false, true]);
  });

  it('release rolls back with the caller transaction', async () => {
    const [line] = await lines(2);
    if (!line) throw new Error('fixture');
    await tx.run((trx) => inventory.reserve([{ ...line, quantity: 2 }], trx));
    await expect(
      tx.run(async (trx) => {
        await inventory.release([{ orderItemId: line.orderItemId, quantity: 2 }], trx);
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');
    expect(await reservationOf(line.orderItemId)).toEqual({ quantity: 2, status: 'active' });
    expect((await stockOf(line.variantId))?.reserved).toBe(2);
  });

  it('commit takes the reserved units out of on_hand once, leaves sellable stock alone and emits nothing', async () => {
    const [line] = await lines(4);
    if (!line) throw new Error('fixture');
    await tx.run((trx) => inventory.reserve([{ ...line, quantity: 2 }], trx));
    await tx.run((trx) => inventory.commit([line.orderItemId], trx));
    await tx.run((trx) => inventory.commit([line.orderItemId], trx)); // replay
    expect(await stockOf(line.variantId)).toEqual({
      variantId: line.variantId,
      onHand: 2,
      reserved: 0,
      sellable: 2,
    });
    expect(await reservationOf(line.orderItemId)).toEqual({ quantity: 2, status: 'committed' });
    expect(
      (await movementsOf(line.orderItemId)).map((m) => [m.type, m.quantity_delta, m.on_hand_after]),
    ).toEqual([
      ['reserve', -2, 4],
      ['commit', 0, 2],
    ]);
    expect(await stockEvents(line.variantId)).toEqual([]);
    // A committed reservation can't be released any more.
    await tx.run((trx) => inventory.release([{ orderItemId: line.orderItemId, quantity: 1 }], trx));
    expect((await stockOf(line.variantId))?.reserved).toBe(0);
  });

  it('adjust can no longer take on_hand below what is reserved', async () => {
    const [line] = await lines(3);
    if (!line) throw new Error('fixture');
    await tx.run((trx) => inventory.reserve([{ ...line, quantity: 2 }], trx));
    await expect(tx.run((trx) => inventory.adjust(line.variantId, -2, actor, trx))).rejects.toMatchObject({
      code: 'STOCK_ADJUSTMENT_INVALID',
    });
  });
});
