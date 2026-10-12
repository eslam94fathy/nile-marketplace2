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

  /** Admin list, keyset page (`limit + 1` rows) over idx_delivery_agents_created_at_id (D-10). */
  async list(query: ParsedListQuery, trx?: DbTransaction): Promise<DeliveryAgent[]> {
    const qb = this.exec(trx)<DeliveryAgentTable>(T).select(...COLUMNS);
    const rows = (await applyListQuery(qb, query, 'id')) as AgentRow[];
    return rows.map(toModel);
  }
}
