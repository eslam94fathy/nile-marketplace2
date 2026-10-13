/** Values match `chk_finance_accounts_account_type` (spec 12 §1.1). */
export const AccountType = {
  SELLER_PAYABLE: 'seller_payable',
  AGENT_FEE_PAYABLE: 'agent_fee_payable',
  AGENT_COD_CASH: 'agent_cod_cash',
  PLATFORM_COMMISSION_REVENUE: 'platform_commission_revenue',
  PLATFORM_DELIVERY_REVENUE: 'platform_delivery_revenue',
} as const;
export type AccountType = (typeof AccountType)[keyof typeof AccountType];

/** Values match `chk_ledger_entries_direction`: a credit raises the balance, a debit lowers it. */
export const EntryDirection = {
  CREDIT: 'credit',
  DEBIT: 'debit',
} as const;
export type EntryDirection = (typeof EntryDirection)[keyof typeof EntryDirection];

/** Values match `chk_ledger_entries_entry_type` (spec 12 §1.2, §1.3). */
export const EntryType = {
  SELLER_NET_EARNED: 'seller_net_earned',
  COMMISSION_EARNED: 'commission_earned',
  AGENT_FEE_EARNED: 'agent_fee_earned',
  PLATFORM_FEE_EARNED: 'platform_fee_earned',
  COD_CASH_COLLECTED: 'cod_cash_collected',
  COD_CASH_REMITTED: 'cod_cash_remitted',
  SELLER_PAYOUT: 'seller_payout',
  AGENT_PAYOUT: 'agent_payout',
} as const;
export type EntryType = (typeof EntryType)[keyof typeof EntryType];

/** Values match `chk_ledger_entries_reference_type` (D-12). */
export const ReferenceType = {
  SELLER_ORDER: 'seller_order',
  ORDER: 'order',
  COD_REMITTANCE: 'cod_remittance',
  PAYOUT: 'payout',
} as const;
export type ReferenceType = (typeof ReferenceType)[keyof typeof ReferenceType];
