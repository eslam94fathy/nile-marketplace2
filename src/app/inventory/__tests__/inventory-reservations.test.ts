import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { InventoryItem } from '../model/inventory-item.model';
import { type InventoryReservation } from '../model/inventory-reservation.model';
import { InventoryService } from '../service/inventory.service';

const TRX = {} as DbTransaction;

/** In-memory stock: item id → [variantId, onHand, reserved]. The repositories mutate it like the SQL does. */
function setup(stock: Record<string, [string, number, number]>, reservations: InventoryReservation[] = []) {
  const itemOf = (id: string) => {
    const row = stock[id];
    if (!row) throw new Error(`no item ${id}`);
    return new InventoryItem({ id, variantId: row[0], onHand: row[1], reserved: row[2] });
  };
  const items = {
    findByVariantIds: vi.fn((variantIds: readonly string[]) =>
      Promise.resolve(
        Object.keys(stock)
          .filter((id) => variantIds.includes(stock[id]?.[0] ?? ''))
          .map(itemOf),
      ),
    ),
    findByIds: vi.fn((ids: readonly string[]) => Promise.resolve(ids.map(itemOf))),
    reserve: vi.fn((id: string, quantity: number) => {
      const row = stock[id];
      if (!row || row[1] - row[2] < quantity) return Promise.resolve(null);
      row[2] += quantity;
      return Promise.resolve(itemOf(id));
    }),
    takeReserved: vi.fn((id: string, quantity: number, mode: 'release' | 'commit') => {
      const row = stock[id];
      if (!row || row[2] < quantity) return Promise.resolve(null);
      row[2] -= quantity;
      if (mode === 'commit') row[1] -= quantity;
      return Promise.resolve(itemOf(id));
    }),
  };
  const reservationRepo = {
    insertMany: vi.fn(() => Promise.resolve()),
    lockByOrderItemIds: vi.fn((ids: readonly string[]) =>
      Promise.resolve(reservations.filter((r) => ids.includes(r.orderItemId))),
    ),
    release: vi.fn(() => Promise.resolve()),
    markCommitted: vi.fn(() => Promise.resolve()),
  };
  const movements = { insertMany: vi.fn(() => Promise.resolve()) };
  const outbox = { add: vi.fn(), addMany: vi.fn(() => Promise.resolve()) };
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.InventoryItemRepository, { useValue: items });
  container.register(TOKENS.InventoryMovementRepository, { useValue: movements });
  container.register(TOKENS.InventoryReservationRepository, { useValue: reservationRepo });
  container.register(TOKENS.Outbox, { useValue: outbox });
  return { items, reservationRepo, movements, outbox, service: container.resolve(InventoryService) };
}

const reservation = (
  orderItemId: string,
  inventoryItemId: string,
  quantity: number,
  status: InventoryReservation['status'] = 'active',
): InventoryReservation => ({ id: `r-${orderItemId}`, inventoryItemId, orderItemId, quantity, status });

describe('InventoryService.reserve (spec 07 UC-IN-1)', () => {
  it('updates items in id order whatever the line order, and records reservations and movements', async () => {
    const { service, items, reservationRepo, movements } = setup({
      'item-b': ['v-b', 5, 0],
      'item-a': ['v-a', 5, 0],
    });
    await service.reserve(
      [
        { variantId: 'v-b', orderItemId: 'oi-b', quantity: 2 },
        { variantId: 'v-a', orderItemId: 'oi-a', quantity: 1 },
      ],
      TRX,
    );
    expect(items.reserve.mock.calls.map((call) => call[0])).toEqual(['item-a', 'item-b']);
    expect(reservationRepo.insertMany).toHaveBeenCalledWith(
      [
        { inventoryItemId: 'item-a', orderItemId: 'oi-a', quantity: 1 },
        { inventoryItemId: 'item-b', orderItemId: 'oi-b', quantity: 2 },
      ],
      TRX,
    );
    expect(movements.insertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: 'reserve',
          quantityDelta: -1,
          reservedAfter: 1,
          referenceType: 'order_item',
          referenceId: 'oi-a',
          actorUserId: null,
        }),
        expect.objectContaining({
          type: 'reserve',
          quantityDelta: -2,
          reservedAfter: 2,
          referenceId: 'oi-b',
        }),
      ],
      TRX,
    );
  });

  it('collects every short line, in the caller order with current sellable, and writes nothing', async () => {
    const { service, items, reservationRepo, movements, outbox } = setup({
      'item-a': ['v-a', 1, 0],
      'item-b': ['v-b', 5, 0],
      'item-c': ['v-c', 3, 2],
    });
    const error = await service
      .reserve(
        [
          { variantId: 'v-c', orderItemId: 'oi-c', quantity: 2 },
          { variantId: 'v-b', orderItemId: 'oi-b', quantity: 1 },
          { variantId: 'v-a', orderItemId: 'oi-a', quantity: 4 },
        ],
        TRX,
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      httpStatus: 409,
      details: [
        { field: 'variantId', value: 'v-c', constraint: 'available', message: 'available: 1' },
        { field: 'variantId', value: 'v-a', constraint: 'available', message: 'available: 1' },
      ],
    });
    expect(items.reserve).toHaveBeenCalledTimes(3); // kept going after the first short line
    expect(reservationRepo.insertMany).not.toHaveBeenCalled();
    expect(movements.insertMany).not.toHaveBeenCalled();
    expect(outbox.addMany).not.toHaveBeenCalled();
  });

  it('a variant without a stock row is an internal error', async () => {
    const { service } = setup({});
    await expect(
      service.reserve([{ variantId: 'v-x', orderItemId: 'oi-x', quantity: 1 }], TRX),
    ).rejects.toMatchObject({
      code: 'INVENTORY_ITEM_NOT_FOUND',
      httpStatus: 500,
    });
  });

  it('emits inventory.stock_status_changed only for items whose sellable stock reaches 0', async () => {
    const { service, outbox } = setup({ 'item-a': ['v-a', 2, 0], 'item-b': ['v-b', 9, 0] });
    await service.reserve(
      [
        { variantId: 'v-a', orderItemId: 'oi-a', quantity: 2 },
        { variantId: 'v-b', orderItemId: 'oi-b', quantity: 2 },
      ],
      TRX,
    );
    expect(outbox.addMany).toHaveBeenCalledWith(TRX, [
      expect.objectContaining({ aggregateId: 'item-a', payload: { variantId: 'v-a', inStock: false } }),
    ]);
  });
});

describe('InventoryService.release (spec 07 UC-IN-2)', () => {
  it('releases partly or fully, skips reservations that are no longer active, and emits when back in stock', async () => {
    const { service, reservationRepo, movements, outbox } = setup(
      { 'item-a': ['v-a', 3, 3], 'item-b': ['v-b', 5, 1] },
      [reservation('oi-a', 'item-a', 3), reservation('oi-b', 'item-b', 1, 'released')],
    );
    await service.release(
      [
        { orderItemId: 'oi-a', quantity: 1 },
        { orderItemId: 'oi-b', quantity: 1 },
      ],
      TRX,
    );
    expect(reservationRepo.release).toHaveBeenCalledTimes(1);
    expect(reservationRepo.release).toHaveBeenCalledWith('r-oi-a', 1, TRX);
    expect(movements.insertMany).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'release', quantityDelta: 1, reservedAfter: 2, referenceId: 'oi-a' })],
      TRX,
    );
    expect(outbox.addMany).toHaveBeenCalledWith(TRX, [
      expect.objectContaining({ payload: { variantId: 'v-a', inStock: true } }),
    ]);
  });

  it('refuses more than is reserved, a missing reservation and a line passed twice (invariant violations)', async () => {
    const make = () => setup({ 'item-a': ['v-a', 3, 2] }, [reservation('oi-a', 'item-a', 2)]);
    await expect(make().service.release([{ orderItemId: 'oi-a', quantity: 3 }], TRX)).rejects.toThrow(
      /cannot release 3/,
    );
    await expect(make().service.release([{ orderItemId: 'oi-x', quantity: 1 }], TRX)).rejects.toThrow(
      /without a reservation: oi-x/,
    );
    await expect(
      make().service.release(
        [
          { orderItemId: 'oi-a', quantity: 1 },
          { orderItemId: 'oi-a', quantity: 1 },
        ],
        TRX,
      ),
    ).rejects.toThrow(/passed twice/);
  });
});

describe('InventoryService.commit (spec 07 UC-IN-3)', () => {
  it('moves active reservations out of on_hand with a 0-delta movement, skips the rest, and emits nothing', async () => {
    const stock: Record<string, [string, number, number]> = { 'item-a': ['v-a', 5, 2] };
    const { service, reservationRepo, movements, outbox } = setup(stock, [
      reservation('oi-a', 'item-a', 2),
      reservation('oi-b', 'item-a', 1, 'committed'),
    ]);
    await service.commit(['oi-a', 'oi-b'], TRX);
    expect(stock['item-a']).toEqual(['v-a', 3, 0]);
    expect(reservationRepo.markCommitted).toHaveBeenCalledTimes(1);
    expect(movements.insertMany).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'commit', quantityDelta: 0, onHandAfter: 3, reservedAfter: 0 })],
      TRX,
    );
    expect(outbox.add).not.toHaveBeenCalled();
    expect(outbox.addMany).not.toHaveBeenCalled();
  });
});
