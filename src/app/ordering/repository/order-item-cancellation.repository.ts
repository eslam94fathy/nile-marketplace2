import { injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { ORDERING_TABLES } from '../constants';
import { type ItemCancelReason } from '../enums';

const T = ORDERING_TABLES.ORDER_ITEM_CANCELLATIONS;

interface OrderItemCancellationTable {
  id: string;
  order_item_id: string;
  quantity: number;
  reason: ItemCancelReason;
  note: string | null;
  actor_user_id: string;
  created_at: Date;
}

/** Append-only record of every partial item cancellation by a seller (spec 09 §3.5). */
@injectable()
export class OrderItemCancellationRepository {
  async insert(
    cancellation: {
      orderItemId: string;
      quantity: number;
      reason: ItemCancelReason;
      note: string | null;
      actorUserId: string;
    },
    trx: DbTransaction,
  ): Promise<void> {
    await trx<OrderItemCancellationTable>(T).insert({
      order_item_id: cancellation.orderItemId,
      quantity: cancellation.quantity,
      reason: cancellation.reason,
      note: cancellation.note,
      actor_user_id: cancellation.actorUserId,
    });
  }
}
