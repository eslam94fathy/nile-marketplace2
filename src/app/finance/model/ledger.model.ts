import { type Money } from '../../../lib/money';
import { MAY_GO_NEGATIVE } from '../constants';
import { type AccountType, EntryDirection, type EntryType, type ReferenceType } from '../enums';

/** Identifies an account before it exists: a type plus its owner (null for the platform accounts). */
export interface AccountKey {
  accountType: AccountType;
  ownerId: string | null;
}

/** One balance per account (spec 12 §1.1). The balance is signed; see `MAY_GO_NEGATIVE`. */
export interface FinanceAccount extends AccountKey {
  id: string;
  balance: Money;
  createdAt: Date;
  updatedAt: Date;
}

/** One line of a booking: moves one account by `amount` (> 0) in `direction`. */
export interface Posting {
  account: AccountKey;
  direction: EntryDirection;
  amount: Money;
  entryType: EntryType;
}

/** Postings that commit together, all pointing at the same reference (spec 12 §1.2, §1.3). */
export interface Booking {
  referenceType: ReferenceType;
  referenceId: string;
  /** The consumed event; null for admin actions. */
  sourceEventId: string | null;
  postings: readonly Posting[];
}

/** An immutable ledger row (append-only). */
export interface LedgerEntry {
  id: string;
  accountId: string;
  direction: EntryDirection;
  amount: Money;
  balanceAfter: Money;
  entryType: EntryType;
  referenceType: ReferenceType;
  referenceId: string;
  sourceEventId: string | null;
  createdAt: Date;
}

/** `balance = Σ credits − Σ debits` (spec 12 §1.1). */
export const applyPosting = (balance: Money, posting: Pick<Posting, 'direction' | 'amount'>): Money =>
  posting.direction === EntryDirection.CREDIT ? balance.plus(posting.amount) : balance.minus(posting.amount);

export const mayGoNegative = (accountType: AccountType): boolean => MAY_GO_NEGATIVE.includes(accountType);

/** A stable string for maps and sorting; the platform accounts use an empty owner. */
export const accountKeyOf = (key: AccountKey): string => `${key.accountType}:${key.ownerId ?? ''}`;
