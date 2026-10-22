import { injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { ORDERING_TABLES } from '../constants';
import { type ReturnLineAmounts } from '../model/return.model';

const T = ORDERING_TABLES.ORDER_ITEM_RETURNS;

interface OrderItemReturnTable {
  id: string;
  return_id: string;
  order_item_id: string;
  quantity: number;
  subtotal_amount: string;
  discount_amount: string;
  paid_amount: string;
  commission_amount: string;
  created_at: Date;
}

/** Append-only record of the units of each line a return took back, with their amounts (spec 09 §8.7). */
@injectable()
export class OrderItemReturnRepository {
  /** One multi-row insert (CLAUDE.md §6.4); the return FK is checked at commit (database §14.11). */
  async insertMany(returnId: string, lines: readonly ReturnLineAmounts[], trx: DbTransaction): Promise<void> {
    if (lines.length === 0) return;
    await trx<OrderItemReturnTable>(T).insert(
      lines.map((line) => ({
        return_id: returnId,
        order_item_id: line.orderItemId,
        quantity: line.quantity,
        subtotal_amount: line.subtotal.toString(),
        discount_amount: line.discount.toString(),
        paid_amount: line.paid.toString(),
        commission_amount: line.commission.toString(),
      })),
    );
  }
}
