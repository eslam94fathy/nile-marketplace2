import { AccountType } from './enums';

export const FINANCE_TABLES = {
  FINANCE_ACCOUNTS: 'finance_accounts',
  LEDGER_ENTRIES: 'ledger_entries',
  COD_REMITTANCES: 'cod_remittances',
  PAYOUTS: 'payouts',
  SELLER_ORDER_HOLDS: 'seller_order_holds',
} as const;

/** Queue of the ledger consumer (docs/spec/02-events.md §2). */
export const LEDGER_QUEUE = 'finance.ledger';

/**
 * Accounts allowed below 0 (spec 12 §1.1, §8.1, FI-1, FI-12, FI-14); `chk_finance_accounts_balance_non_negative`. A
 * payout never takes a seller below 0 (strict bookings, §8.1).
 */
export const MAY_GO_NEGATIVE: readonly AccountType[] = [
  AccountType.PLATFORM_DELIVERY_REVENUE,
  AccountType.SELLER_PAYABLE,
  AccountType.PLATFORM_PROMOTIONS,
];

/** Platform accounts have no owner (owner_id null). */
export const PLATFORM_ACCOUNT_TYPES: readonly AccountType[] = [
  AccountType.PLATFORM_COMMISSION_REVENUE,
  AccountType.PLATFORM_DELIVERY_REVENUE,
  AccountType.PLATFORM_PROMOTIONS,
];

/** Admin paths under /api/v1 (spec 12 §4.1). */
export const FINANCE_ADMIN_PATHS = {
  ACCOUNTS: '/admin/finance/accounts',
  ACCOUNT: '/admin/finance/accounts/:accountId',
  ACCOUNT_ENTRIES: '/admin/finance/accounts/:accountId/entries',
  ENTRIES: '/admin/finance/entries',
  COD_REMITTANCES: '/admin/finance/cod-remittances',
  PAYOUTS: '/admin/finance/payouts',
} as const;

/** The seller's own paths (spec 12 §4.2). */
export const SELLER_FINANCE_PATHS = {
  BALANCE: '/seller/finance/balance',
  ENTRIES: '/seller/finance/entries',
  PAYOUTS: '/seller/finance/payouts',
  HOLDS: '/seller/finance/holds',
} as const;

/** The agent's own paths (spec 12 §4.3). */
export const AGENT_FINANCE_PATHS = {
  BALANCES: '/agent/finance/balances',
  ENTRIES: '/agent/finance/entries',
  REMITTANCES: '/agent/finance/remittances',
} as const;

/** Lengths of the admin request fields, matching the columns (database §11). */
export const REMITTANCE_NOTE_MAX_LENGTH = 500;
export const EXTERNAL_REFERENCE_MAX_LENGTH = 200;
