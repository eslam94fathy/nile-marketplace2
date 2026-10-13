import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import {
  accountKeyOf,
  type AccountKey,
  applyPosting,
  type Booking,
  type FinanceAccount,
  type LedgerEntry,
  mayGoNegative,
} from '../model/ledger.model';
import { type FinanceAccountRepository } from '../repository/finance-account.repository';
import { type LedgerEntryRepository, type NewLedgerEntry } from '../repository/ledger-entry.repository';

/**
 * A posting would take an account that may not go negative below 0. Admin actions map it to their
 * error code (spec 12 §1.3); in a booking from an event it is a bug, so the event is retried.
 */
export class InsufficientBalanceError extends Error {
  override readonly name = 'InsufficientBalanceError';

  constructor(
    readonly account: AccountKey,
    readonly balance: Money,
  ) {
    super(`account ${accountKeyOf(account)} has ${balance.toString()}, not enough for the posting`);
  }
}

/**
 * The only writer of balances (spec 12 §1.1). One booking, inside the caller's transaction:
 * create the missing accounts, lock them sorted by id, append the entries, update each balance.
 */
@injectable()
export class LedgerService {
  constructor(
    @inject(TOKENS.FinanceAccountRepository) private readonly accounts: FinanceAccountRepository,
    @inject(TOKENS.LedgerEntryRepository) private readonly entries: LedgerEntryRepository,
  ) {}

  async post(booking: Booking, trx: DbTransaction): Promise<LedgerEntry[]> {
    if (booking.postings.length === 0) return [];
    for (const posting of booking.postings) {
      if (!posting.amount.greaterThan(Money.zero())) {
        throw new RangeError(`posting amounts must be > 0, got ${posting.amount.toString()}`);
      }
    }

    const byKey = await this.lockAccounts(
      booking.postings.map((p) => p.account),
      trx,
    );
    const balances = new Map<string, Money>();
    const rows: NewLedgerEntry[] = booking.postings.map((posting) => {
      const key = accountKeyOf(posting.account);
      const account = byKey.get(key);
      if (!account) throw new Error(`finance account ${key} was not locked`);
      const balanceAfter = applyPosting(balances.get(key) ?? account.balance, posting);
      if (balanceAfter.isNegative() && !mayGoNegative(account.accountType)) {
        throw new InsufficientBalanceError(posting.account, balances.get(key) ?? account.balance);
      }
      balances.set(key, balanceAfter);
      return {
        accountId: account.id,
        direction: posting.direction,
        amount: posting.amount,
        balanceAfter,
        entryType: posting.entryType,
        referenceType: booking.referenceType,
        referenceId: booking.referenceId,
        sourceEventId: booking.sourceEventId,
      };
    });

    const inserted = await this.entries.insertMany(rows, trx);
    for (const [key, balance] of balances) {
      const account = byKey.get(key);
      if (account) await this.accounts.updateBalance(account.id, balance, trx);
    }
    return inserted;
  }

  /**
   * Creates the missing accounts (keys sorted, one statement), then locks them all in one
   * `ORDER BY id FOR UPDATE` (spec 12 FI-3). Returns them by `accountKeyOf`.
   */
  private async lockAccounts(
    keys: readonly AccountKey[],
    trx: DbTransaction,
  ): Promise<Map<string, FinanceAccount>> {
    const distinct = [...new Map(keys.map((key) => [accountKeyOf(key), key])).entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, key]) => key);
    await this.accounts.ensure(distinct, trx);
    const locked = await this.accounts.lockByKeys(distinct, trx);
    return new Map(locked.map((account) => [accountKeyOf(account), account]));
  }
}
