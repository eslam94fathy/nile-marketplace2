import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { InventoryStockStatusChanged, type IOutbox, type OutboxEvent } from '../../../lib/events';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { MOVEMENT_REFERENCE_ORDER_ITEM, MOVEMENT_REFERENCE_RETURN } from '../constants';
import { MovementType } from '../enums';
import { insufficientStock, inventoryItemNotFound, type ShortLine, stockAdjustmentInvalid } from '../errors';
import { type InventoryItem, type StockDto, stockStatusChange } from '../model/inventory-item.model';
import { type InventoryMovement, type NewInventoryMovement } from '../model/inventory-movement.model';
import {
  type InventoryReservation,
  isActive,
  type ReleaseLine,
  type ReserveLine,
  type RestockLine,
} from '../model/inventory-reservation.model';
import { type InventoryItemRepository } from '../repository/inventory-item.repository';
import { type InventoryMovementRepository } from '../repository/inventory-movement.repository';
import { type InventoryReservationRepository } from '../repository/inventory-reservation.repository';

/** Sellable stock of one item before the first and after the last change of one call. */
interface SellableChange {
  variantId: string;
  before: number;
  after: number;
}

/** Item rows are always changed in id order: one lock order across checkouts (architecture §3.1). */
const byItemId =
  <T>(itemId: (entry: T) => string) =>
  (a: T, b: T): number =>
    itemId(a) < itemId(b) ? -1 : itemId(a) > itemId(b) ? 1 : 0;

/**
 * Public API of inventory (spec 07 §2). Writes take the caller's transaction and record a movement
 * per changed line; adjust, reserve, release and restock emit `inventory.stock_status_changed` when sellable
 * stock crosses 0. A movement's `quantity_delta` is the change in sellable stock, so a commit
 * records 0 (its effect shows in `on_hand_after`).
 */
export interface IInventoryService {
  /** Stock row for a new variant. Emits no event: catalog recomputes `in_stock` in the same trx (IN-2). */
  createItem(
    variantId: string,
    initialStock: number,
    actorUserId: string,
    trx: DbTransaction,
  ): Promise<StockDto>;
  /** Seller stock delta (S-6). Throws STOCK_ADJUSTMENT_INVALID if on_hand would go below 0 or `reserved`. */
  adjust(variantId: string, delta: number, actorUserId: string, trx: DbTransaction): Promise<StockDto>;
  /** One batched query; variants without a stock row are left out. */
  getStockByVariantIds(variantIds: readonly string[], trx?: DbTransaction): Promise<StockDto[]>;
  /**
   * Checkout (UC-IN-1): reserves every line or none. Short lines are collected and thrown together as
   * INSUFFICIENT_STOCK; the caller's transaction then rolls back the lines already reserved.
   */
  reserve(lines: readonly ReserveLine[], trx: DbTransaction): Promise<void>;
  /**
   * Releases part or all of each line's reservation (UC-IN-2). A reservation that is no longer active
   * is skipped, so replays are harmless.
   */
  release(lines: readonly ReleaseLine[], trx: DbTransaction): Promise<void>;
  /** Delivered (UC-IN-3): active reservations leave on_hand; others are skipped. Emits nothing. */
  commit(orderItemIds: readonly string[], trx: DbTransaction): Promise<void>;
  /**
   * Returned units back on hand (spec 07 §8, spec 18 UC-RE-7): items locked in id order, `on_hand +=`
   * the units, one `return_restock` movement per item and return; emits
   * `inventory.stock_status_changed` when sellable stock crosses 0. Deleted variants are restocked
   * too (their row exists).
   */
  restock(lines: readonly RestockLine[], actorUserId: string | null, trx: DbTransaction): Promise<void>;
  /** Seller stock history, newest first (parse the query with INVENTORY_MOVEMENT_LIST_SPEC). */
  listMovements(
    variantId: string,
    query: ParsedListQuery,
  ): Promise<{ items: InventoryMovement[]; meta: PageMeta }>;
}

@injectable()
export class InventoryService implements IInventoryService {
  constructor(
    @inject(TOKENS.InventoryItemRepository) private readonly items: InventoryItemRepository,
    @inject(TOKENS.InventoryMovementRepository) private readonly movements: InventoryMovementRepository,
    @inject(TOKENS.InventoryReservationRepository)
    private readonly reservations: InventoryReservationRepository,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
  ) {}

  async createItem(
    variantId: string,
    initialStock: number,
    actorUserId: string,
    trx: DbTransaction,
  ): Promise<StockDto> {
    const item = await this.items.insert(variantId, initialStock, trx);
    if (initialStock > 0) {
      await this.movements.insertMany([this.adjustmentMovement(item, initialStock, actorUserId)], trx);
    }
    return item.toStock();
  }

  async adjust(variantId: string, delta: number, actorUserId: string, trx: DbTransaction): Promise<StockDto> {
    const item = await this.items.applyDelta(variantId, delta, trx);
    if (!item) {
      // Only on the failure path: tell a refused adjustment from a missing row (a bug).
      if (!(await this.items.existsForVariant(variantId, trx))) throw inventoryItemNotFound(variantId);
      throw stockAdjustmentInvalid();
    }
    await this.movements.insertMany([this.adjustmentMovement(item, delta, actorUserId)], trx);

    const change = stockStatusChange(item.sellable - delta, item.sellable);
    if (change) {
      await this.outbox.add(trx, {
        contract: InventoryStockStatusChanged,
        aggregateId: item.id,
        payload: { variantId, inStock: change.inStock },
      });
    }
    return item.toStock();
  }

  async getStockByVariantIds(variantIds: readonly string[], trx?: DbTransaction): Promise<StockDto[]> {
    return (await this.items.findByVariantIds(variantIds, trx)).map((item) => item.toStock());
  }

  async reserve(lines: readonly ReserveLine[], trx: DbTransaction): Promise<void> {
    if (lines.length === 0) return;
    const itemIds = new Map(
      (
        await this.items.findByVariantIds(
          lines.map((l) => l.variantId),
          trx,
        )
      ).map((i) => [i.variantId, i.id]),
    );
    const work = lines
      .map((line) => {
        const itemId = itemIds.get(line.variantId);
        if (!itemId) throw inventoryItemNotFound(line.variantId);
        return { line, itemId };
      })
      .sort(byItemId((entry) => entry.itemId));

    const short = new Set<ReserveLine>();
    const changes = new Map<string, SellableChange>();
    const movements: NewInventoryMovement[] = [];
    for (const { line, itemId } of work) {
      const after = await this.items.reserve(itemId, line.quantity, trx);
      if (!after) {
        short.add(line); // keep going, so the client sees every short line at once
        continue;
      }
      track(changes, after, -line.quantity);
      movements.push(reservationMovement(after, MovementType.RESERVE, -line.quantity, line.orderItemId));
    }
    if (short.size > 0) throw insufficientStock(await this.shortLines(lines, short, itemIds, trx));

    await this.reservations.insertMany(
      work.map(({ line, itemId }) => ({
        inventoryItemId: itemId,
        orderItemId: line.orderItemId,
        quantity: line.quantity,
      })),
      trx,
    );
    await this.movements.insertMany(movements, trx);
    await this.emitCrossings(changes, trx);
  }

  async release(lines: readonly ReleaseLine[], trx: DbTransaction): Promise<void> {
    const quantities = new Map(lines.map((l) => [l.orderItemId, l.quantity]));
    const work = (await this.lockActive([...quantities.keys()], lines.length, trx))
      .map((reservation) => {
        const quantity = quantities.get(reservation.orderItemId) ?? 0;
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > reservation.quantity) {
          throw new Error(
            `cannot release ${quantity} of reservation ${reservation.id} (${reservation.quantity} reserved)`,
          );
        }
        return { reservation, quantity };
      })
      .sort(byItemId((entry) => entry.reservation.inventoryItemId));

    const changes = new Map<string, SellableChange>();
    const movements: NewInventoryMovement[] = [];
    for (const { reservation, quantity } of work) {
      const after = await this.takeReserved(reservation, quantity, 'release', trx);
      await this.reservations.release(reservation.id, quantity, trx);
      track(changes, after, quantity);
      movements.push(reservationMovement(after, MovementType.RELEASE, quantity, reservation.orderItemId));
    }
    await this.movements.insertMany(movements, trx);
    await this.emitCrossings(changes, trx);
  }

  async commit(orderItemIds: readonly string[], trx: DbTransaction): Promise<void> {
    const ids = [...new Set(orderItemIds)];
    const work = (await this.lockActive(ids, orderItemIds.length, trx)).sort(
      byItemId((reservation) => reservation.inventoryItemId),
    );
    const movements: NewInventoryMovement[] = [];
    for (const reservation of work) {
      const after = await this.takeReserved(reservation, reservation.quantity, 'commit', trx);
      await this.reservations.markCommitted(reservation.id, trx);
      movements.push(reservationMovement(after, MovementType.COMMIT, 0, reservation.orderItemId));
    }
    await this.movements.insertMany(movements, trx);
  }

  async restock(
    lines: readonly RestockLine[],
    actorUserId: string | null,
    trx: DbTransaction,
  ): Promise<void> {
    const totals = new Map<string, RestockLine>();
    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) {
        throw new Error(`cannot restock ${line.quantity} of variant ${line.variantId}`);
      }
      const key = `${line.variantId}:${line.returnId}`;
      const sum = totals.get(key);
      totals.set(key, sum ? { ...sum, quantity: sum.quantity + line.quantity } : { ...line });
    }
    if (totals.size === 0) return;

    const items = await this.items.findByVariantIds([...new Set(lines.map((l) => l.variantId))], trx);
    const itemIds = new Map(items.map((item) => [item.variantId, item.id]));
    const work = [...totals.values()]
      .map((line) => {
        const itemId = itemIds.get(line.variantId);
        if (!itemId) throw inventoryItemNotFound(line.variantId);
        return { line, itemId };
      })
      .sort(byItemId((entry) => entry.itemId));

    const changes = new Map<string, SellableChange>();
    const movements: NewInventoryMovement[] = [];
    for (const { line, itemId } of work) {
      const after = await this.items.addOnHand(itemId, line.quantity, trx);
      if (!after) throw new Error(`inventory item ${itemId} vanished`);
      track(changes, after, line.quantity);
      movements.push({
        inventoryItemId: after.id,
        type: MovementType.RETURN_RESTOCK,
        quantityDelta: line.quantity,
        onHandAfter: after.onHand,
        reservedAfter: after.reserved,
        referenceType: MOVEMENT_REFERENCE_RETURN,
        referenceId: line.returnId,
        actorUserId,
      });
    }
    await this.movements.insertMany(movements, trx);
    await this.emitCrossings(changes, trx);
  }

  async listMovements(
    variantId: string,
    query: ParsedListQuery,
  ): Promise<{ items: InventoryMovement[]; meta: PageMeta }> {
    const itemId = await this.items.findIdByVariantId(variantId);
    if (!itemId) throw inventoryItemNotFound(variantId);
    return toPage(await this.movements.listByItem(itemId, query), query, (m) => m.createdAt);
  }

  /**
   * Locks the reservations of these lines and keeps the active ones. Every line must have one (order
   * lines are reserved in the checkout transaction that creates them), and passing a line twice is a
   * caller bug: both are invariant violations, not client errors.
   */
  private async lockActive(
    orderItemIds: readonly string[],
    passedCount: number,
    trx: DbTransaction,
  ): Promise<InventoryReservation[]> {
    if (orderItemIds.length !== passedCount) throw new Error('the same order item was passed twice');
    const locked = await this.reservations.lockByOrderItemIds(orderItemIds, trx);
    if (locked.length !== orderItemIds.length) {
      const found = new Set(locked.map((r) => r.orderItemId));
      const missing = orderItemIds.filter((id) => !found.has(id));
      throw new Error(`order items without a reservation: ${missing.join(', ')}`);
    }
    return locked.filter(isActive);
  }

  /** The locked reservation accounts for the units, so a refused update is an invariant violation. */
  private async takeReserved(
    reservation: InventoryReservation,
    quantity: number,
    mode: 'release' | 'commit',
    trx: DbTransaction,
  ): Promise<InventoryItem> {
    const after = await this.items.takeReserved(reservation.inventoryItemId, quantity, mode, trx);
    if (!after) {
      throw new Error(`inventory item ${reservation.inventoryItemId} has fewer than ${quantity} reserved`);
    }
    return after;
  }

  /** The short lines in the caller's order, each with its sellable stock now. */
  private async shortLines(
    lines: readonly ReserveLine[],
    short: ReadonlySet<ReserveLine>,
    itemIds: ReadonlyMap<string, string>,
    trx: DbTransaction,
  ): Promise<ShortLine[]> {
    const shortLines = lines.filter((line) => short.has(line));
    const ids = shortLines.flatMap((line) => itemIds.get(line.variantId) ?? []);
    const sellable = new Map(
      (await this.items.findByIds(ids, trx)).map((item) => [item.variantId, Math.max(item.sellable, 0)]),
    );
    return shortLines.map((line) => ({
      variantId: line.variantId,
      available: sellable.get(line.variantId) ?? 0,
    }));
  }

  private async emitCrossings(
    changes: ReadonlyMap<string, SellableChange>,
    trx: DbTransaction,
  ): Promise<void> {
    const events: OutboxEvent<object>[] = [];
    for (const [itemId, change] of changes) {
      const crossing = stockStatusChange(change.before, change.after);
      if (crossing) {
        events.push({
          contract: InventoryStockStatusChanged,
          aggregateId: itemId,
          payload: { variantId: change.variantId, inStock: crossing.inStock },
        });
      }
    }
    await this.outbox.addMany(trx, events);
  }

  private adjustmentMovement(item: InventoryItem, delta: number, actorUserId: string) {
    return {
      inventoryItemId: item.id,
      type: MovementType.SELLER_ADJUSTMENT,
      quantityDelta: delta,
      onHandAfter: item.onHand,
      reservedAfter: item.reserved,
      referenceType: null,
      referenceId: null,
      actorUserId,
    };
  }
}

/** Keeps the item's sellable stock before its first change in this call, and after its last. */
function track(changes: Map<string, SellableChange>, after: InventoryItem, sellableDelta: number): void {
  changes.set(after.id, {
    variantId: after.variantId,
    before: changes.get(after.id)?.before ?? after.sellable - sellableDelta,
    after: after.sellable,
  });
}

function reservationMovement(
  item: InventoryItem,
  type: MovementType,
  sellableDelta: number,
  orderItemId: string,
): NewInventoryMovement {
  return {
    inventoryItemId: item.id,
    type,
    quantityDelta: sellableDelta,
    onHandAfter: item.onHand,
    reservedAfter: item.reserved,
    referenceType: MOVEMENT_REFERENCE_ORDER_ITEM,
    referenceId: orderItemId,
    actorUserId: null,
  };
}
