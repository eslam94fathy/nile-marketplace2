import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IInventoryService, INVENTORY_MOVEMENT_LIST_SPEC } from '../../src/app/inventory';
import { type ITransactionRunner } from '../../src/lib/db';
import { TOKENS } from '../../src/lib/di';
import { parseListQuery } from '../../src/lib/http';
import { catalogFixtures } from '../helpers/catalog-fixtures';
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
