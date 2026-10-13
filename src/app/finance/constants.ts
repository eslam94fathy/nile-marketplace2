import { AccountType } from './enums';

export const FINANCE_TABLES = {
  FINANCE_ACCOUNTS: 'finance_accounts',
  LEDGER_ENTRIES: 'ledger_entries',
  COD_REMITTANCES: 'cod_remittances',
  PAYOUTS: 'payouts',
} as const;

/** Queue of the ledger consumer (docs/spec/02-events.md §2). */
export const LEDGER_QUEUE = 'finance.ledger';

/** The only account allowed below 0 (spec 12 §1.1, FI-1); `chk_finance_accounts_balance_non_negative`. */
export const MAY_GO_NEGATIVE: readonly AccountType[] = [AccountType.PLATFORM_DELIVERY_REVENUE];

/** Platform accounts have no owner (owner_id null). */
export const PLATFORM_ACCOUNT_TYPES: readonly AccountType[] = [
  AccountType.PLATFORM_COMMISSION_REVENUE,
  AccountType.PLATFORM_DELIVERY_REVENUE,
];
