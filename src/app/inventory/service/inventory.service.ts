import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { InventoryStockStatusChanged, type IOutbox } from '../../../lib/events';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { MovementType } from '../enums';
import { inventoryItemNotFound, stockAdjustmentInvalid } from '../errors';
import { type InventoryItem, type StockDto, stockStatusChange } from '../model/inventory-item.model';
import { type InventoryMovement } from '../model/inventory-movement.model';
import { type InventoryItemRepository } from '../repository/inventory-item.repository';
import { type InventoryMovementRepository } from '../repository/inventory-movement.repository';

/**
 * Public API of inventory (spec 07 §2). Writes take the caller's transaction, record a movement,
 * and (adjust) emit `inventory.stock_status_changed` when sellable stock crosses 0.
 * reserve / release / commit land with checkout in Phase 5 (IN-1).
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

  async listMovements(
    variantId: string,
    query: ParsedListQuery,
  ): Promise<{ items: InventoryMovement[]; meta: PageMeta }> {
    const itemId = await this.items.findIdByVariantId(variantId);
    if (!itemId) throw inventoryItemNotFound(variantId);
    return toPage(await this.movements.listByItem(itemId, query), query, (m) => m.createdAt);
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
