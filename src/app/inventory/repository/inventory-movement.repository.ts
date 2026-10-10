import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { INVENTORY_TABLES } from '../constants';
import { type MovementType } from '../enums';
import { type NewInventoryMovement, type InventoryMovement } from '../model/inventory-movement.model';

const T = INVENTORY_TABLES.INVENTORY_MOVEMENTS;
const COLUMNS = [
  'id',
  'type',
  'quantity_delta',
  'on_hand_after',
  'reserved_after',
  'reference_type',
  'reference_id',
  'created_at',
] as const;

interface InventoryMovementTable {
  id: string;
  inventory_item_id: string;
  type: MovementType;
  quantity_delta: number;
  on_hand_after: number;
  reserved_after: number;
  reference_type: string | null;
  reference_id: string | null;
  actor_user_id: string | null;
  created_at: Date;
}

type MovementRow = Pick<InventoryMovementTable, (typeof COLUMNS)[number]>;

/** Append-only: rows are written in the same transaction as the stock change they record. */
@injectable()
export class InventoryMovementRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** One multi-row insert (CLAUDE.md §6.4). */
  async insertMany(movements: readonly NewInventoryMovement[], trx: DbTransaction): Promise<void> {
    if (movements.length === 0) return;
    await trx<InventoryMovementTable>(T).insert(
      movements.map((m) => ({
        inventory_item_id: m.inventoryItemId,
        type: m.type,
        quantity_delta: m.quantityDelta,
        on_hand_after: m.onHandAfter,
        reserved_after: m.reservedAfter,
        reference_type: m.referenceType,
        reference_id: m.referenceId,
        actor_user_id: m.actorUserId,
      })),
    );
  }

  /** Keyset page over idx_inventory_movements_inventory_item_id_created_at_id (D-6); `limit + 1` rows. */
  async listByItem(
    inventoryItemId: string,
    query: ParsedListQuery,
    trx?: DbTransaction,
  ): Promise<InventoryMovement[]> {
    const qb = this.exec(trx)<InventoryMovementTable>(T)
      .select(...COLUMNS)
      .where({ inventory_item_id: inventoryItemId });
    const rows = (await applyListQuery(qb, query, 'id')) as MovementRow[];
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      quantityDelta: row.quantity_delta,
      onHandAfter: row.on_hand_after,
      reservedAfter: row.reserved_after,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      createdAt: row.created_at,
    }));
  }
}
