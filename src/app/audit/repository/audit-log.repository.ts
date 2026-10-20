import { inject, injectable } from 'tsyringe';
import { type AuditAction, type AuditTargetType } from '../../../lib/audit';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { AUDIT_TABLES } from '../constants';
import { type AuditActorType } from '../enums';
import { type AuditChanges, type AuditLogEntry, type NewAuditLogEntry } from '../model/audit-log-entry.model';

const T = AUDIT_TABLES.ADMIN_AUDIT_LOG;
const COLUMNS = [
  'id',
  'actor_type',
  'actor_user_id',
  'action',
  'target_type',
  'target_id',
  'changes',
  'reason',
  'correlation_id',
  'ip',
  'created_at',
] as const;

interface AuditLogRow {
  id: string;
  actor_type: AuditActorType;
  actor_user_id: string | null;
  action: AuditAction;
  target_type: AuditTargetType;
  target_id: string | null;
  changes: AuditChanges | null;
  reason: string | null;
  correlation_id: string | null;
  ip: string | null;
  created_at: Date;
}

function toModel(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    changes: row.changes,
    reason: row.reason,
    correlationId: row.correlation_id,
    ip: row.ip,
    createdAt: row.created_at,
  };
}

/** All SQL of `admin_audit_log`. Insert and delete only: an UPDATE is rejected by a trigger (BO-2). */
@injectable()
export class AuditLogRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** Always in the caller's transaction: the row commits or rolls back with the audited change. */
  async insert(entry: NewAuditLogEntry, trx: DbTransaction): Promise<void> {
    await trx<AuditLogRow>(T).insert({
      actor_type: entry.actorType,
      actor_user_id: entry.actorUserId,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      // JSONB: knex would send a plain object as a Postgres record literal.
      changes: entry.changes === null ? null : (JSON.stringify(entry.changes) as unknown as AuditChanges),
      reason: entry.reason,
      correlation_id: entry.correlationId,
      ip: entry.ip,
    });
  }

  async list(query: ParsedListQuery): Promise<AuditLogEntry[]> {
    const qb = this.db.knex<AuditLogRow>(T).select(...COLUMNS);
    const rows = (await applyListQuery(qb, query, 'id')) as AuditLogRow[];
    return rows.map(toModel);
  }

  async findById(id: string): Promise<AuditLogEntry | undefined> {
    const row = await this.exec()<AuditLogRow>(T)
      .select(...COLUMNS)
      .where({ id })
      .first();
    return row ? toModel(row) : undefined;
  }

  /** One batch of the retention job (spec 20 §2.4), oldest first. Returns the rows deleted. */
  async deleteOlderThan(cutoff: Date, batchSize: number): Promise<number> {
    const result = await this.db.knex.raw<{ rowCount: number }>(
      `DELETE FROM ${T} WHERE id IN (
         SELECT id FROM ${T} WHERE created_at < ? ORDER BY created_at, id LIMIT ?)`,
      [cutoff, batchSize],
    );
    return result.rowCount;
  }
}
