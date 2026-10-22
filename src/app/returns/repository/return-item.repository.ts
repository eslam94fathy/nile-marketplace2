import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { RETURNS_TABLES } from '../constants';
import { type ReturnItem } from '../model/return-request.model';

const T = RETURNS_TABLES.ITEMS;
const COLUMNS = ['id', 'return_id', 'order_item_id', 'quantity', 'restock'] as const;

interface ReturnItemTable {
  id: string;
  return_id: string;
  order_item_id: string;
  quantity: number;
  restock: boolean | null;
  created_at: Date;
  updated_at: Date;
}

const toModel = (row: Pick<ReturnItemTable, (typeof COLUMNS)[number]>): ReturnItem => ({
  id: row.id,
  returnId: row.return_id,
  orderItemId: row.order_item_id,
  quantity: row.quantity,
  restock: row.restock,
});

/** All SQL of `return_items` (spec 18 §1). */
@injectable()
export class ReturnItemRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /** One multi-row insert (CLAUDE.md §6.4); restock is decided at receipt. */
  async insertMany(
    returnId: string,
    lines: readonly { orderItemId: string; quantity: number }[],
    trx: DbTransaction,
  ): Promise<ReturnItem[]> {
    const rows = await trx<ReturnItemTable>(T)
      .insert(
        lines.map((line) => ({
          return_id: returnId,
          order_item_id: line.orderItemId,
          quantity: line.quantity,
          restock: null,
        })),
      )
      .returning(COLUMNS);
    return rows.map(toModel);
  }

  /** The seller's restock choice per item at completion (UC-RE-7); one statement for the whole return. */
  async setRestock(
    returnId: string,
    restock: ReadonlyMap<string, boolean>,
    trx: DbTransaction,
  ): Promise<void> {
    if (restock.size === 0) return;
    const ids = [...restock.keys()];
    await trx<ReturnItemTable>(T)
      .update({
        restock: trx.raw(
          `CASE id ${ids.map(() => 'WHEN ?::uuid THEN ?::boolean').join(' ')} END`,
          ids.flatMap((id) => [id, restock.get(id) ?? false]),
        ),
        updated_at: trx.fn.now(),
      })
      .where({ return_id: returnId })
      .whereIn('id', ids);
  }

  /** Items of a page of requests: WHERE return_id = ANY(?) over uq_return_items_return_id_order_item_id (G20). */
  async findByReturnIds(returnIds: readonly string[], trx?: DbTransaction): Promise<ReturnItem[]> {
    if (returnIds.length === 0) return [];
    const rows = await (trx ?? this.db.knex)<ReturnItemTable>(T)
      .select(...COLUMNS)
      .whereIn('return_id', [...new Set(returnIds)])
      .orderBy([{ column: 'return_id' }, { column: 'created_at' }, { column: 'id' }]);
    return rows.map(toModel);
  }
}
