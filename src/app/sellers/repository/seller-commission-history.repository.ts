import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Rate } from '../../../lib/money';
import { SELLERS_TABLES } from '../constants';

const T = SELLERS_TABLES.SELLER_COMMISSION_HISTORY;
const COLUMNS = ['old_rate', 'new_rate', 'changed_by_user_id', 'created_at'] as const;

interface CommissionHistoryTable {
  id: string;
  seller_id: string;
  old_rate: string;
  new_rate: string;
  changed_by_user_id: string;
  created_at: Date;
}

export interface CommissionChangeEntry {
  oldRate: Rate;
  newRate: Rate;
  changedByUserId: string;
  createdAt: Date;
}

/** Append-only: one row per per-seller commission change (spec 05 UC-SE-3). */
@injectable()
export class SellerCommissionHistoryRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async insert(
    sellerId: string,
    entry: Omit<CommissionChangeEntry, 'createdAt'>,
    trx: DbTransaction,
  ): Promise<void> {
    await trx<CommissionHistoryTable>(T).insert({
      seller_id: sellerId,
      old_rate: entry.oldRate.toString(),
      new_rate: entry.newRate.toString(),
      changed_by_user_id: entry.changedByUserId,
    });
  }

  /** Newest first (admin audit view). */
  async listBySeller(sellerId: string, limit: number, trx?: DbTransaction): Promise<CommissionChangeEntry[]> {
    const rows = await this.exec(trx)<CommissionHistoryTable>(T)
      .select(...COLUMNS)
      .where({ seller_id: sellerId })
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit);
    return rows.map((row) => ({
      oldRate: Rate.of(row.old_rate),
      newRate: Rate.of(row.new_rate),
      changedByUserId: row.changed_by_user_id,
      createdAt: row.created_at,
    }));
  }
}
