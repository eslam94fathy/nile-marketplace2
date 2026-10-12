import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { ORDERING_TABLES } from '../constants';
import { type ActorRole, type OrderStatus, type SellerOrderStatus } from '../enums';
import { type StatusHistoryEntry } from '../model/order.model';

const COLUMNS = ['from_status', 'to_status', 'actor_role', 'actor_user_id', 'reason', 'created_at'] as const;

interface HistoryRow {
  subject_id: string;
  from_status: string | null;
  to_status: string;
  actor_role: ActorRole;
  actor_user_id: string | null;
  reason: string | null;
  created_at: Date;
}

export type NewHistoryEntry<S extends string> = Omit<StatusHistoryEntry<S>, 'createdAt'>;

/**
 * Both append-only status histories (spec 09 §1.1): `order_status_history` and
 * `seller_order_status_history`. Rows are written in the same transaction as the change they record.
 */
@injectable()
export class StatusHistoryRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  addOrderEntries(entries: readonly NewHistoryEntry<OrderStatus>[], trx: DbTransaction): Promise<void> {
    return this.insert(ORDERING_TABLES.ORDER_STATUS_HISTORY, 'order_id', entries, trx);
  }

  addSellerOrderEntries(
    entries: readonly NewHistoryEntry<SellerOrderStatus>[],
    trx: DbTransaction,
  ): Promise<void> {
    return this.insert(ORDERING_TABLES.SELLER_ORDER_STATUS_HISTORY, 'seller_order_id', entries, trx);
  }

  /** Timelines, oldest first: WHERE order_id = ANY(?) over idx_order_status_history_order_id_created_at. */
  listForOrders(
    orderIds: readonly string[],
    trx?: DbTransaction,
  ): Promise<StatusHistoryEntry<OrderStatus>[]> {
    return this.list(ORDERING_TABLES.ORDER_STATUS_HISTORY, 'order_id', orderIds, trx);
  }

  /** Over idx_seller_order_status_history_seller_order_id_created_at. */
  listForSellerOrders(
    sellerOrderIds: readonly string[],
    trx?: DbTransaction,
  ): Promise<StatusHistoryEntry<SellerOrderStatus>[]> {
    return this.list(ORDERING_TABLES.SELLER_ORDER_STATUS_HISTORY, 'seller_order_id', sellerOrderIds, trx);
  }

  /** One multi-row insert (CLAUDE.md §6.4). */
  private async insert<S extends string>(
    table: string,
    subjectColumn: string,
    entries: readonly NewHistoryEntry<S>[],
    trx: DbTransaction,
  ): Promise<void> {
    if (entries.length === 0) return;
    await trx(table).insert(
      entries.map((entry) => ({
        [subjectColumn]: entry.subjectId,
        from_status: entry.fromStatus,
        to_status: entry.toStatus,
        actor_role: entry.actorRole,
        actor_user_id: entry.actorUserId,
        reason: entry.reason,
      })),
    );
  }

  private async list<S extends string>(
    table: string,
    subjectColumn: string,
    subjectIds: readonly string[],
    trx?: DbTransaction,
  ): Promise<StatusHistoryEntry<S>[]> {
    if (subjectIds.length === 0) return [];
    const rows = await this.exec(trx)(table)
      .select<HistoryRow[]>(`${subjectColumn} as subject_id`, ...COLUMNS)
      .whereIn(subjectColumn, [...new Set(subjectIds)])
      .orderBy([{ column: 'created_at' }, { column: 'id' }]);
    return rows.map((row) => ({
      subjectId: row.subject_id,
      fromStatus: row.from_status as S | null,
      toStatus: row.to_status as S,
      actorRole: row.actor_role,
      actorUserId: row.actor_user_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }
}
