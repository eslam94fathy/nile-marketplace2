import { injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { INVENTORY_TABLES } from '../constants';
import { ReservationStatus } from '../enums';
import { type InventoryReservation } from '../model/inventory-reservation.model';

const T = INVENTORY_TABLES.INVENTORY_RESERVATIONS;
const COLUMNS = ['id', 'inventory_item_id', 'order_item_id', 'quantity', 'status'] as const;

interface InventoryReservationTable {
  id: string;
  inventory_item_id: string;
  order_item_id: string;
  quantity: number;
  status: ReservationStatus;
  created_at: Date;
  updated_at: Date;
}

type ReservationRow = Pick<InventoryReservationTable, (typeof COLUMNS)[number]>;

function toModel(row: ReservationRow): InventoryReservation {
  return {
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    orderItemId: row.order_item_id,
    quantity: row.quantity,
    status: row.status,
  };
}

/** Every method is a write path and runs inside the caller's transaction. */
@injectable()
export class InventoryReservationRepository {
  /** One multi-row insert of `active` reservations (CLAUDE.md §6.4). */
  async insertMany(
    reservations: readonly { inventoryItemId: string; orderItemId: string; quantity: number }[],
    trx: DbTransaction,
  ): Promise<void> {
    if (reservations.length === 0) return;
    await trx<InventoryReservationTable>(T).insert(
      reservations.map((r) => ({
        inventory_item_id: r.inventoryItemId,
        order_item_id: r.orderItemId,
        quantity: r.quantity,
        status: ReservationStatus.ACTIVE,
      })),
    );
  }

  /**
   * Locks the reservations of these order lines (`FOR UPDATE`, ordered by id) so release / commit
   * read and change them without a race. Lines without a reservation are left out.
   */
  async lockByOrderItemIds(
    orderItemIds: readonly string[],
    trx: DbTransaction,
  ): Promise<InventoryReservation[]> {
    if (orderItemIds.length === 0) return [];
    const rows = await trx<InventoryReservationTable>(T)
      .select(...COLUMNS)
      .whereIn('order_item_id', [...new Set(orderItemIds)])
      .orderBy('id')
      .forUpdate();
    return rows.map(toModel);
  }

  /** Lowers what is still reserved; reaching 0 marks it `released` (D-9). The caller holds the row lock. */
  async release(id: string, quantity: number, trx: DbTransaction): Promise<void> {
    await trx<InventoryReservationTable>(T)
      .update({
        quantity: trx.raw('quantity - ?', [quantity]),
        status: trx.raw('CASE WHEN quantity - ? = 0 THEN ? ELSE status END', [
          quantity,
          ReservationStatus.RELEASED,
        ]),
        updated_at: trx.fn.now(),
      })
      .where({ id });
  }

  /** The caller holds the row lock and has checked it is `active`. */
  async markCommitted(id: string, trx: DbTransaction): Promise<void> {
    await trx<InventoryReservationTable>(T)
      .update({ status: ReservationStatus.COMMITTED, updated_at: trx.fn.now() })
      .where({ id });
  }
}
