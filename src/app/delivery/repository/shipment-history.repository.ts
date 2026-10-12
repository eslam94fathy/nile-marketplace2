import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { DELIVERY_TABLES } from '../constants';
import { type AttemptFailureReason, type DeliveryActorRole, type ShipmentStatus } from '../enums';
import { type ShipmentAttempt, type ShipmentHistoryEntry } from '../model/shipment.model';

const H = DELIVERY_TABLES.SHIPMENT_STATUS_HISTORY;
const A = DELIVERY_TABLES.SHIPMENT_ATTEMPTS;

interface HistoryRow {
  shipment_id: string;
  from_status: ShipmentStatus | null;
  to_status: ShipmentStatus;
  actor_role: DeliveryActorRole;
  actor_user_id: string | null;
  reason: string | null;
  created_at: Date;
}

interface AttemptRow {
  shipment_id: string;
  attempt_number: number;
  reason: AttemptFailureReason;
  note: string | null;
  agent_id: string;
  created_at: Date;
}

/**
 * The shipment's two append-only records: its status history (spec 11 §1.1) and its failed attempts
 * (UC-DE-3). Rows are written in the same transaction as the change they record.
 */
@injectable()
export class ShipmentHistoryRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async add(entry: Omit<ShipmentHistoryEntry, 'createdAt'>, trx: DbTransaction): Promise<void> {
    await trx<HistoryRow>(H).insert({
      shipment_id: entry.shipmentId,
      from_status: entry.fromStatus,
      to_status: entry.toStatus,
      actor_role: entry.actorRole,
      actor_user_id: entry.actorUserId,
      reason: entry.reason,
    });
  }

  async addAttempt(
    attempt: Omit<ShipmentAttempt, 'createdAt'> & { agentId: string },
    trx: DbTransaction,
  ): Promise<void> {
    await trx<AttemptRow>(A).insert({
      shipment_id: attempt.shipmentId,
      attempt_number: attempt.attemptNumber,
      reason: attempt.reason,
      note: attempt.note,
      agent_id: attempt.agentId,
    });
  }

  /** Oldest first: idx_shipment_status_history_shipment_id_created_at (G20). */
  async listFor(shipmentIds: readonly string[], trx?: DbTransaction): Promise<ShipmentHistoryEntry[]> {
    if (shipmentIds.length === 0) return [];
    const rows = await this.exec(trx)<HistoryRow>(H)
      .select(
        'shipment_id',
        'from_status',
        'to_status',
        'actor_role',
        'actor_user_id',
        'reason',
        'created_at',
      )
      .whereIn('shipment_id', [...new Set(shipmentIds)])
      .orderBy([{ column: 'created_at' }, { column: 'id' }]);
    return rows.map((row) => ({
      shipmentId: row.shipment_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actorRole: row.actor_role,
      actorUserId: row.actor_user_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  /** In attempt order: uq_shipment_attempts_shipment_id_attempt_number (G20). */
  async attemptsFor(shipmentIds: readonly string[], trx?: DbTransaction): Promise<ShipmentAttempt[]> {
    if (shipmentIds.length === 0) return [];
    const rows = await this.exec(trx)<AttemptRow>(A)
      .select('shipment_id', 'attempt_number', 'reason', 'note', 'created_at')
      .whereIn('shipment_id', [...new Set(shipmentIds)])
      .orderBy([{ column: 'shipment_id' }, { column: 'attempt_number' }]);
    return rows.map((row) => ({
      shipmentId: row.shipment_id,
      attemptNumber: row.attempt_number,
      reason: row.reason,
      note: row.note,
      createdAt: row.created_at,
    }));
  }
}
