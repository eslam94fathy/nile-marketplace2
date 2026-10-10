import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { INVENTORY_TABLES } from '../constants';
import { InventoryItem } from '../model/inventory-item.model';

const T = INVENTORY_TABLES.INVENTORY_ITEMS;
const COLUMNS = ['id', 'variant_id', 'on_hand', 'reserved'] as const;

interface InventoryItemTable {
  id: string;
  variant_id: string;
  on_hand: number;
  reserved: number;
  created_at: Date;
  updated_at: Date;
}

type InventoryItemRow = Pick<InventoryItemTable, (typeof COLUMNS)[number]>;

function toModel(row: InventoryItemRow): InventoryItem {
  return new InventoryItem({
    id: row.id,
    variantId: row.variant_id,
    onHand: row.on_hand,
    reserved: row.reserved,
  });
}

@injectable()
export class InventoryItemRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async insert(variantId: string, onHand: number, trx: DbTransaction): Promise<InventoryItem> {
    const [row] = await trx<InventoryItemTable>(T)
      .insert({ variant_id: variantId, on_hand: onHand, reserved: 0 })
      .returning<InventoryItemRow[]>(COLUMNS);
    if (!row) throw new Error('inventory_items insert returned no row');
    return toModel(row);
  }

  /**
   * Conditional atomic update (CLAUDE.md §6.4): applies `delta` only if on_hand stays >= reserved
   * and >= 0. Returns the item after the change, or null when no row qualified.
   */
  async applyDelta(variantId: string, delta: number, trx: DbTransaction): Promise<InventoryItem | null> {
    const [row] = await trx<InventoryItemTable>(T)
      .update({
        on_hand: trx.raw('on_hand + ?', [delta]),
        updated_at: trx.fn.now(),
      })
      .where({ variant_id: variantId })
      .whereRaw('on_hand + ? >= reserved', [delta])
      .whereRaw('on_hand + ? >= 0', [delta])
      .returning<InventoryItemRow[]>(COLUMNS);
    return row ? toModel(row) : null;
  }

  async existsForVariant(variantId: string, trx?: DbTransaction): Promise<boolean> {
    const db = this.exec(trx);
    const result = await db.raw<{ rows: { exists: boolean }[] }>(
      `SELECT EXISTS (SELECT 1 FROM ${T} WHERE variant_id = ?) AS "exists"`,
      [variantId],
    );
    return result.rows[0]?.exists ?? false;
  }

  /** One batched `variant_id IN (...)` query (G20); variants without a row are left out. */
  async findByVariantIds(variantIds: readonly string[], trx?: DbTransaction): Promise<InventoryItem[]> {
    if (variantIds.length === 0) return [];
    const rows = await this.exec(trx)<InventoryItemTable>(T)
      .select(...COLUMNS)
      .whereIn('variant_id', [...new Set(variantIds)]);
    return rows.map(toModel);
  }

  async findIdByVariantId(variantId: string, trx?: DbTransaction): Promise<string | null> {
    const row = await this.exec(trx)<InventoryItemTable>(T)
      .select('id')
      .where({ variant_id: variantId })
      .first<Pick<InventoryItemTable, 'id'> | undefined>();
    return row?.id ?? null;
  }
}
