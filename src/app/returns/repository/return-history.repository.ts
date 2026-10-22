import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { RETURNS_TABLES } from '../constants';
import { type ReturnActorRole, type ReturnStatus } from '../enums';
import { type ReturnHistoryEntry } from '../model/return-request.model';

const T = RETURNS_TABLES.STATUS_HISTORY;

interface ReturnHistoryTable {
  id: string;
  return_id: string;
  from_status: ReturnStatus | null;
  to_status: ReturnStatus;
  actor_role: ReturnActorRole;
  actor_user_id: string | null;
  reason: string | null;
  created_at: Date;
}

/** Append-only `return_status_history` (spec 18 §1.1), written in the transition's transaction. */
@injectable()
export class ReturnHistoryRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  async insert(entry: Omit<ReturnHistoryEntry, 'createdAt'>, trx: DbTransaction): Promise<void> {
    await trx<ReturnHistoryTable>(T).insert({
      return_id: entry.returnId,
      from_status: entry.fromStatus,
      to_status: entry.toStatus,
      actor_role: entry.actorRole,
      actor_user_id: entry.actorUserId,
      reason: entry.reason,
    });
  }

  /** Timelines of a page of requests, oldest first: idx_return_status_history_return_id_created_at (G20). */
  async findByReturnIds(returnIds: readonly string[]): Promise<ReturnHistoryEntry[]> {
    if (returnIds.length === 0) return [];
    const rows = await this.db
      .knex<ReturnHistoryTable>(T)
      .select('return_id', 'from_status', 'to_status', 'actor_role', 'actor_user_id', 'reason', 'created_at')
      .whereIn('return_id', [...new Set(returnIds)])
      .orderBy([{ column: 'return_id' }, { column: 'created_at' }, { column: 'id' }]);
    return rows.map((row) => ({
      returnId: row.return_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actorRole: row.actor_role,
      actorUserId: row.actor_user_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }
}
