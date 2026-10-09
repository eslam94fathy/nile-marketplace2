import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { SELLERS_TABLES } from '../constants';
import { type SellerStatus } from '../enums';

const T = SELLERS_TABLES.SELLER_STATUS_HISTORY;
const COLUMNS = ['from_status', 'to_status', 'reason', 'actor_user_id', 'created_at'] as const;

interface StatusHistoryTable {
  id: string;
  seller_id: string;
  from_status: SellerStatus | null;
  to_status: SellerStatus;
  reason: string | null;
  actor_user_id: string | null;
  created_at: Date;
}

export interface StatusChangeEntry {
  fromStatus: SellerStatus | null;
  toStatus: SellerStatus;
  reason: string | null;
  /** null = system. */
  actorUserId: string | null;
  createdAt: Date;
}

/** Append-only: one row per status change, in the same transaction as the change. */
@injectable()
export class SellerStatusHistoryRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async insert(
    sellerId: string,
    entry: Omit<StatusChangeEntry, 'createdAt'>,
    trx: DbTransaction,
  ): Promise<void> {
    await trx<StatusHistoryTable>(T).insert({
      seller_id: sellerId,
      from_status: entry.fromStatus,
      to_status: entry.toStatus,
      reason: entry.reason,
      actor_user_id: entry.actorUserId,
    });
  }

  /** Newest first (admin audit view). */
  async listBySeller(sellerId: string, limit: number, trx?: DbTransaction): Promise<StatusChangeEntry[]> {
    const rows = await this.exec(trx)<StatusHistoryTable>(T)
      .select(...COLUMNS)
      .where({ seller_id: sellerId })
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit);
    return rows.map((row) => ({
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      actorUserId: row.actor_user_id,
      createdAt: row.created_at,
    }));
  }
}
