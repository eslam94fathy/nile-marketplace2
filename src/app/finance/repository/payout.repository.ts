import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Money } from '../../../lib/money';
import { FINANCE_TABLES } from '../constants';
import { type PayeeType } from '../enums';
import { type Payout } from '../model/settlement.model';

const T = FINANCE_TABLES.PAYOUTS;
const COLUMNS = [
  'id',
  'payee_type',
  'payee_id',
  'amount',
  'external_reference',
  'recorded_by_user_id',
  'paid_at',
  'created_at',
] as const;

interface PayoutTable {
  id: string;
  payee_type: PayeeType;
  payee_id: string;
  amount: string;
  external_reference: string;
  recorded_by_user_id: string;
  paid_at: Date;
  created_at: Date;
}

type PayoutRow = Pick<PayoutTable, (typeof COLUMNS)[number]>;

const toModel = (row: PayoutRow): Payout => ({
  id: row.id,
  payeeType: row.payee_type,
  payeeId: row.payee_id,
  amount: Money.of(row.amount),
  externalReference: row.external_reference,
  recordedByUserId: row.recorded_by_user_id,
  paidAt: row.paid_at,
  createdAt: row.created_at,
});

@injectable()
export class PayoutRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** uq_payouts_payee_type_payee_id_external_reference maps to PAYOUT_ALREADY_RECORDED (FI-7). */
  async insert(payout: Omit<Payout, 'id' | 'createdAt'>, trx: DbTransaction): Promise<Payout> {
    const [row] = await trx<PayoutTable>(T)
      .insert({
        payee_type: payout.payeeType,
        payee_id: payout.payeeId,
        amount: payout.amount.toString(),
        external_reference: payout.externalReference,
        recorded_by_user_id: payout.recordedByUserId,
        paid_at: payout.paidAt,
      })
      .returning<PayoutRow[]>(COLUMNS);
    if (!row) throw new Error('payouts insert returned no row');
    return toModel(row);
  }

  /**
   * Keyset page (`limit + 1` rows): over idx_payouts_payee_type_payee_id_created_at_id with a payee
   * filter, else idx_payouts_created_at_id (D-12). `payee` scopes it to one payee (their own list).
   */
  async list(
    query: ParsedListQuery,
    payee?: { payeeType: PayeeType; payeeId: string },
    trx?: DbTransaction,
  ): Promise<Payout[]> {
    const qb = this.exec(trx)<PayoutTable>(T).select(...COLUMNS);
    if (payee) void qb.where({ payee_type: payee.payeeType, payee_id: payee.payeeId });
    const rows = (await applyListQuery(qb, query, 'id')) as PayoutRow[];
    return rows.map(toModel);
  }
}
