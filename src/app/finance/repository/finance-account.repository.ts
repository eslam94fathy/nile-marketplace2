import { type Knex } from 'knex';
import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Money } from '../../../lib/money';
import { FINANCE_TABLES } from '../constants';
import { type AccountType } from '../enums';
import { type AccountKey, type FinanceAccount } from '../model/ledger.model';

const T = FINANCE_TABLES.FINANCE_ACCOUNTS;
const COLUMNS = ['id', 'account_type', 'owner_id', 'balance', 'created_at', 'updated_at'] as const;

interface FinanceAccountTable {
  id: string;
  account_type: AccountType;
  owner_id: string | null;
  balance: string;
  created_at: Date;
  updated_at: Date;
}

type FinanceAccountRow = Pick<FinanceAccountTable, (typeof COLUMNS)[number]>;

const toModel = (row: FinanceAccountRow): FinanceAccount => ({
  id: row.id,
  accountType: row.account_type,
  ownerId: row.owner_id,
  balance: Money.of(row.balance),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** `(account_type, owner_id)` matches, with `IS NOT DISTINCT FROM` so the platform accounts (null owner) match too. */
function matchingKeys(keys: readonly AccountKey[]) {
  return (qb: Knex.QueryBuilder): void => {
    for (const key of keys) {
      void qb.orWhere((inner) => {
        void inner
          .where('account_type', key.accountType)
          .whereRaw('owner_id IS NOT DISTINCT FROM ?::uuid', [key.ownerId]);
      });
    }
  };
}

@injectable()
export class FinanceAccountRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /**
   * Creates the missing accounts at 0.00 in one statement (spec 12 FI-3). Callers pass the keys
   * sorted, so two bookings creating the same new accounts wait on each other in the same order.
   */
  async ensure(keys: readonly AccountKey[], trx: DbTransaction): Promise<void> {
    if (keys.length === 0) return;
    await trx<FinanceAccountTable>(T)
      .insert(
        keys.map((key) => ({
          account_type: key.accountType,
          owner_id: key.ownerId,
          balance: Money.zero().toString(),
        })),
      )
      .onConflict(['account_type', 'owner_id'])
      .ignore();
  }

  /** Locks the accounts `FOR UPDATE` sorted by id, so concurrent bookings never deadlock (spec 12 §1.1). */
  async lockByKeys(keys: readonly AccountKey[], trx: DbTransaction): Promise<FinanceAccount[]> {
    if (keys.length === 0) return [];
    const rows = await trx<FinanceAccountTable>(T)
      .select(...COLUMNS)
      .where(matchingKeys(keys))
      .orderBy('id')
      .forUpdate();
    return (rows as FinanceAccountRow[]).map(toModel);
  }

  async findById(id: string, trx?: DbTransaction): Promise<FinanceAccount | null> {
    const row = await this.exec(trx)<FinanceAccountTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .first<FinanceAccountRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** The accounts of these keys that exist, over uq_finance_accounts_account_type_owner_id. */
  async findByKeys(keys: readonly AccountKey[], trx?: DbTransaction): Promise<FinanceAccount[]> {
    if (keys.length === 0) return [];
    const rows = await this.exec(trx)<FinanceAccountTable>(T)
      .select(...COLUMNS)
      .where(matchingKeys(keys));
    return (rows as FinanceAccountRow[]).map(toModel);
  }

  /** Admin list, keyset page (`limit + 1` rows) over idx_finance_accounts_balance_id / _updated_at_id (D-12). */
  async list(query: ParsedListQuery, trx?: DbTransaction): Promise<FinanceAccount[]> {
    const qb = this.exec(trx)<FinanceAccountTable>(T).select(...COLUMNS);
    const rows = (await applyListQuery(qb, query, 'id')) as FinanceAccountRow[];
    return rows.map(toModel);
  }

  async updateBalance(id: string, balance: Money, trx: DbTransaction): Promise<void> {
    const updated = await trx<FinanceAccountTable>(T)
      .where({ id })
      .update({ balance: balance.toString(), updated_at: trx.fn.now() });
    if (updated !== 1) throw new Error(`finance account ${id} was not updated`);
  }
}
