import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { FINANCE_TABLES } from '../constants';
import { type EntryDirection, type EntryType, type ReferenceType } from '../enums';
import { type LedgerEntry } from '../model/ledger.model';

const T = FINANCE_TABLES.LEDGER_ENTRIES;
const COLUMNS = [
  'id',
  'account_id',
  'direction',
  'amount',
  'balance_after',
  'entry_type',
  'reference_type',
  'reference_id',
  'source_event_id',
  'created_at',
] as const;

interface LedgerEntryTable {
  id: string;
  account_id: string;
  direction: EntryDirection;
  amount: string;
  balance_after: string;
  entry_type: EntryType;
  reference_type: ReferenceType;
  reference_id: string;
  source_event_id: string | null;
  created_at: Date;
}

type LedgerEntryRow = Pick<LedgerEntryTable, (typeof COLUMNS)[number]>;

const toModel = (row: LedgerEntryRow): LedgerEntry => ({
  id: row.id,
  accountId: row.account_id,
  direction: row.direction,
  amount: Money.of(row.amount),
  balanceAfter: Money.of(row.balance_after),
  entryType: row.entry_type,
  referenceType: row.reference_type,
  referenceId: row.reference_id,
  sourceEventId: row.source_event_id,
  createdAt: row.created_at,
});

export type NewLedgerEntry = Omit<LedgerEntry, 'id' | 'createdAt'>;

@injectable()
export class LedgerEntryRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** One multi-row insert for a whole booking (CLAUDE.md §6.4). */
  async insertMany(entries: readonly NewLedgerEntry[], trx: DbTransaction): Promise<LedgerEntry[]> {
    if (entries.length === 0) return [];
    const rows = await trx<LedgerEntryTable>(T)
      .insert(
        entries.map((entry) => ({
          account_id: entry.accountId,
          direction: entry.direction,
          amount: entry.amount.toString(),
          balance_after: entry.balanceAfter.toString(),
          entry_type: entry.entryType,
          reference_type: entry.referenceType,
          reference_id: entry.referenceId,
          source_event_id: entry.sourceEventId,
        })),
      )
      .returning<LedgerEntryRow[]>(COLUMNS);
    return rows.map(toModel);
  }

  /** Money movements of one reference, over idx_ledger_entries_reference_type_reference_id. */
  async findByReference(
    referenceType: ReferenceType,
    referenceId: string,
    trx?: DbTransaction,
  ): Promise<LedgerEntry[]> {
    const rows = await this.exec(trx)<LedgerEntryTable>(T)
      .select(...COLUMNS)
      .where({ reference_type: referenceType, reference_id: referenceId })
      .orderBy([{ column: 'created_at' }, { column: 'id' }]);
    return (rows as LedgerEntryRow[]).map(toModel);
  }
}
