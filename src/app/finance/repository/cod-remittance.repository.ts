import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Money } from '../../../lib/money';
import { FINANCE_TABLES } from '../constants';
import { type CodRemittance } from '../model/settlement.model';

const T = FINANCE_TABLES.COD_REMITTANCES;
const COLUMNS = ['id', 'agent_id', 'amount', 'confirmed_by_user_id', 'note', 'created_at'] as const;

interface CodRemittanceTable {
  id: string;
  agent_id: string;
  amount: string;
  confirmed_by_user_id: string;
  note: string | null;
  created_at: Date;
}

type CodRemittanceRow = Pick<CodRemittanceTable, (typeof COLUMNS)[number]>;

const toModel = (row: CodRemittanceRow): CodRemittance => ({
  id: row.id,
  agentId: row.agent_id,
  amount: Money.of(row.amount),
  confirmedByUserId: row.confirmed_by_user_id,
  note: row.note,
  createdAt: row.created_at,
});

@injectable()
export class CodRemittanceRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async insert(
    remittance: Pick<CodRemittance, 'agentId' | 'amount' | 'confirmedByUserId' | 'note'>,
    trx: DbTransaction,
  ): Promise<CodRemittance> {
    const [row] = await trx<CodRemittanceTable>(T)
      .insert({
        agent_id: remittance.agentId,
        amount: remittance.amount.toString(),
        confirmed_by_user_id: remittance.confirmedByUserId,
        note: remittance.note,
      })
      .returning<CodRemittanceRow[]>(COLUMNS);
    if (!row) throw new Error('cod_remittances insert returned no row');
    return toModel(row);
  }

  /**
   * Keyset page (`limit + 1` rows): over idx_cod_remittances_agent_id_created_at_id with an agent
   * filter, else idx_cod_remittances_created_at_id (D-12). `agentId` scopes it to one agent (the
   * agent's own list).
   */
  async list(query: ParsedListQuery, agentId?: string, trx?: DbTransaction): Promise<CodRemittance[]> {
    const qb = this.exec(trx)<CodRemittanceTable>(T).select(...COLUMNS);
    if (agentId !== undefined) void qb.where({ agent_id: agentId });
    const rows = (await applyListQuery(qb, query, 'id')) as CodRemittanceRow[];
    return rows.map(toModel);
  }
}
