import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { AppError } from '../../../lib/error';
import { InventoryItem, stockStatusChange } from '../model/inventory-item.model';
import { InventoryService } from '../service/inventory.service';

const TRX = {} as DbTransaction;
const ACTOR = 'user-1';
const item = (onHand: number, reserved = 0) =>
  new InventoryItem({ id: 'item-1', variantId: 'variant-1', onHand, reserved });

function setup(afterDelta: InventoryItem | null = item(5), exists = true) {
  const items = {
    insert: vi.fn((_variantId: string, onHand: number) => Promise.resolve(item(onHand))),
    applyDelta: vi.fn(() => Promise.resolve(afterDelta)),
    existsForVariant: vi.fn(() => Promise.resolve(exists)),
  };
  const movements = { insertMany: vi.fn(() => Promise.resolve()) };
  const outbox = { add: vi.fn(() => Promise.resolve()), addMany: vi.fn() };
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.InventoryItemRepository, { useValue: items });
  container.register(TOKENS.InventoryMovementRepository, { useValue: movements });
  container.register(TOKENS.Outbox, { useValue: outbox });
  return { items, movements, outbox, service: container.resolve(InventoryService) };
}

describe('stockStatusChange (spec 07 §2)', () => {
  it.each([
    [0, 3, { inStock: true }],
    [3, 0, { inStock: false }],
    [2, 5, null],
    [5, 1, null],
    [0, 0, null],
  ])('sellable %i → %i gives %o', (before, after, expected) => {
    expect(stockStatusChange(before, after)).toEqual(expected);
  });
});

describe('InventoryService', () => {
  it('createItem writes a movement only for positive initial stock, and never an event (IN-2)', async () => {
    const { service, movements, outbox } = setup();
    expect(await service.createItem('variant-1', 0, ACTOR, TRX)).toEqual({
      variantId: 'variant-1',
      onHand: 0,
      reserved: 0,
      sellable: 0,
    });
    expect(movements.insertMany).not.toHaveBeenCalled();

    await service.createItem('variant-1', 7, ACTOR, TRX);
    expect(movements.insertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: 'seller_adjustment',
          quantityDelta: 7,
          onHandAfter: 7,
          actorUserId: ACTOR,
        }),
      ],
      TRX,
    );
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('adjust records the movement and emits only when sellable crosses 0', async () => {
    const crossing = setup(item(4, 1)); // sellable 0 → 3 after +3
    await crossing.service.adjust('variant-1', 3, ACTOR, TRX);
    expect(crossing.movements.insertMany).toHaveBeenCalledWith(
      [expect.objectContaining({ quantityDelta: 3, onHandAfter: 4, reservedAfter: 1 })],
      TRX,
    );
    expect(crossing.outbox.add).toHaveBeenCalledWith(
      TRX,
      expect.objectContaining({ aggregateId: 'item-1', payload: { variantId: 'variant-1', inStock: true } }),
    );

    const staying = setup(item(9)); // sellable 6 → 9
    await staying.service.adjust('variant-1', 3, ACTOR, TRX);
    expect(staying.outbox.add).not.toHaveBeenCalled();
  });

  it('adjust refuses with STOCK_ADJUSTMENT_INVALID, or INVENTORY_ITEM_NOT_FOUND when the row is missing', async () => {
    const refused = setup(null, true);
    await expect(refused.service.adjust('variant-1', -9, ACTOR, TRX)).rejects.toMatchObject({
      code: 'STOCK_ADJUSTMENT_INVALID',
      httpStatus: 422,
    });
    expect(refused.movements.insertMany).not.toHaveBeenCalled();

    const missing = setup(null, false);
    const error = await missing.service.adjust('variant-1', 1, ACTOR, TRX).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'INVENTORY_ITEM_NOT_FOUND', httpStatus: 500, isOperational: false });
  });
});
