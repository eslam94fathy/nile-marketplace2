import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { DELIVERY_TABLES } from '../constants';
import { ACTIVE_SHIPMENT_STATUSES, type AgentStatus } from '../enums';
import { type DeliveryAgent } from '../model/delivery-agent.model';

const T = DELIVERY_TABLES.DELIVERY_AGENTS;
const COLUMNS = [
  'id',
  'user_id',
  'full_name',
  'phone',
  'home_governorate_id',
  'status',
  'on_shift',
  'last_assigned_at',
  'created_at',
] as const;

interface DeliveryAgentTable {
  id: string;
  user_id: string;
  full_name: string;
  phone: string;
  home_governorate_id: string;
  status: AgentStatus;
  on_shift: boolean;
  last_assigned_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type AgentRow = Pick<DeliveryAgentTable, (typeof COLUMNS)[number]>;

function toModel(row: AgentRow): DeliveryAgent {
  return {
    id: row.id,
    userId: row.user_id,
    fullName: row.full_name,
    phone: row.phone,
    homeGovernorateId: row.home_governorate_id,
    status: row.status,
    onShift: row.on_shift,
    lastAssignedAt: row.last_assigned_at,
    createdAt: row.created_at,
  };
}

export type AgentChanges = Partial<
  Pick<DeliveryAgent, 'fullName' | 'phone' | 'homeGovernorateId' | 'status' | 'onShift'>
>;

@injectable()
export class DeliveryAgentRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** A new agent is active and off shift (spec 11 UC-DE-6). */
  async insert(
    agent: { userId: string; fullName: string; phone: string; homeGovernorateId: string },
    trx: DbTransaction,
  ): Promise<DeliveryAgent> {
    const [row] = await trx<DeliveryAgentTable>(T)
      .insert({
        user_id: agent.userId,
        full_name: agent.fullName,
        phone: agent.phone,
        home_governorate_id: agent.homeGovernorateId,
        status: 'active',
        on_shift: false,
        last_assigned_at: null,
      })
      .returning<AgentRow[]>(COLUMNS);
    if (!row) throw new Error('delivery_agents insert returned no row');
    return toModel(row);
  }

  async findById(id: string, trx?: DbTransaction): Promise<DeliveryAgent | null> {
    const row = await this.exec(trx)<DeliveryAgentTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .first<AgentRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** Over uq_delivery_agents_user_id: the agent of a JWT `sub`. */
  async findByUserId(userId: string, trx?: DbTransaction): Promise<DeliveryAgent | null> {
    const row = await this.exec(trx)<DeliveryAgentTable>(T)
      .select(...COLUMNS)
      .where({ user_id: userId })
      .first<AgentRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** One batched `id IN (...)` query (G20). */
  /** Profile id → user id, one batched query on the primary key; unknown ids are left out. */
  async findUserIds(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .knex<{ id: string; user_id: string }>(T)
      .select('id', 'user_id')
      .whereIn('id', [...new Set(ids)]);
    return new Map(rows.map((row) => [row.id, row.user_id]));
  }

  async findByIds(ids: readonly string[], trx?: DbTransaction): Promise<DeliveryAgent[]> {
    if (ids.length === 0) return [];
    const rows = await this.exec(trx)<DeliveryAgentTable>(T)
      .select(...COLUMNS)
      .whereIn('id', [...new Set(ids)]);
    return rows.map(toModel);
  }

  /** Locks the agent row (`FOR UPDATE`): availability, deactivation and assignment serialize on it (DE-7). */
  async lockById(id: string, trx: DbTransaction): Promise<DeliveryAgent | null> {
    const row = await trx<DeliveryAgentTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .forUpdate()
      .first<AgentRow | undefined>();
    return row ? toModel(row) : null;
  }

  async update(id: string, changes: AgentChanges, trx: DbTransaction): Promise<DeliveryAgent> {
    const [row] = await trx<DeliveryAgentTable>(T)
      .update({
        ...(changes.fullName !== undefined ? { full_name: changes.fullName } : {}),
        ...(changes.phone !== undefined ? { phone: changes.phone } : {}),
        ...(changes.homeGovernorateId !== undefined
          ? { home_governorate_id: changes.homeGovernorateId }
          : {}),
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(changes.onShift !== undefined ? { on_shift: changes.onShift } : {}),
        updated_at: trx.fn.now(),
      })
      .where({ id })
      .returning<AgentRow[]>(COLUMNS);
    if (!row) throw new Error(`delivery agent ${id} vanished under its lock`);
    return toModel(row);
  }

  /** The agents' open work (spec 11 §1): one grouped query over idx_shipments_agent_id_status (G20). */
  async activeShipmentCounts(agentIds: readonly string[], trx?: DbTransaction): Promise<Map<string, number>> {
    if (agentIds.length === 0) return new Map();
    const { rows } = await this.exec(trx).raw<{ rows: { agent_id: string; count: string }[] }>(
      `SELECT agent_id, count(*) AS count FROM ${DELIVERY_TABLES.SHIPMENTS}
        WHERE agent_id = ANY(?::uuid[]) AND status = ANY(?::text[])
        GROUP BY agent_id`,
      [[...new Set(agentIds)], [...ACTIVE_SHIPMENT_STATUSES]],
    );
    return new Map(rows.map((row) => [row.agent_id, Number(row.count)]));
  }

  /**
   * Auto-assignment candidate (spec 11 UC-DE-1, overview §4.6): an active, on-shift agent of the
   * governorate with the fewest active shipments, then the longest idle; the row comes back locked,
   * and agents another assignment holds are skipped, so two shipments never take the same slot.
   * Over idx_delivery_agents_home_governorate_id_last_assigned_at and idx_shipments_agent_id_status.
   */
  async lockCandidate(governorateId: string, trx: DbTransaction): Promise<DeliveryAgent | null> {
    const { rows } = await trx.raw<{ rows: AgentRow[] }>(
      `SELECT ${COLUMNS.map((c) => `a.${c}`).join(', ')}
         FROM ${T} a
        WHERE a.home_governorate_id = ? AND a.status = 'active' AND a.on_shift
        ORDER BY (SELECT count(*) FROM ${DELIVERY_TABLES.SHIPMENTS} s
                   WHERE s.agent_id = a.id AND s.status = ANY(?::text[])),
                 a.last_assigned_at NULLS FIRST, a.id
        LIMIT 1
        FOR UPDATE OF a SKIP LOCKED`,
      [governorateId, [...ACTIVE_SHIPMENT_STATUSES]],
    );
    const row = rows[0];
    return row ? toModel(row) : null;
  }

  async setLastAssignedAt(id: string, at: Date, trx: DbTransaction): Promise<void> {
    await trx<DeliveryAgentTable>(T).update({ last_assigned_at: at, updated_at: trx.fn.now() }).where({ id });
  }

  /** Admin list, keyset page (`limit + 1` rows) over idx_delivery_agents_created_at_id (D-10). */
  async list(query: ParsedListQuery, trx?: DbTransaction): Promise<DeliveryAgent[]> {
    const qb = this.exec(trx)<DeliveryAgentTable>(T).select(...COLUMNS);
    const rows = (await applyListQuery(qb, query, 'id')) as AgentRow[];
    return rows.map(toModel);
  }
}
