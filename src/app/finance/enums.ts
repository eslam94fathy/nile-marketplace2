/** Values match `chk_finance_accounts_account_type` (spec 12 §1.1, §8.1). */
export const AccountType = {
  SELLER_PAYABLE: 'seller_payable',
  AGENT_FEE_PAYABLE: 'agent_fee_payable',
  AGENT_COD_CASH: 'agent_cod_cash',
  PLATFORM_COMMISSION_REVENUE: 'platform_commission_revenue',
  PLATFORM_DELIVERY_REVENUE: 'platform_delivery_revenue',
  /** Seller earnings held while the return window is open (R-16). */
  SELLER_PENDING: 'seller_pending',
  /** What the platform owes a customer for a completed return. */
  CUSTOMER_REFUND_PAYABLE: 'customer_refund_payable',
  /** Platform-funded coupon discounts; only goes negative (FI-14, FI-20). */
  PLATFORM_PROMOTIONS: 'platform_promotions',
} as const;
export type AccountType = (typeof AccountType)[keyof typeof AccountType];

/** Values match `chk_ledger_entries_direction`: a credit raises the balance, a debit lowers it. */
export const EntryDirection = {
  CREDIT: 'credit',
  DEBIT: 'debit',
} as const;
export type EntryDirection = (typeof EntryDirection)[keyof typeof EntryDirection];

/** Values match `chk_ledger_entries_entry_type` (spec 12 §1.2, §1.3, §8.1). */
export const EntryType = {
  SELLER_NET_EARNED: 'seller_net_earned',
  COMMISSION_EARNED: 'commission_earned',
  AGENT_FEE_EARNED: 'agent_fee_earned',
  PLATFORM_FEE_EARNED: 'platform_fee_earned',
  COD_CASH_COLLECTED: 'cod_cash_collected',
  COD_CASH_REMITTED: 'cod_cash_remitted',
  SELLER_PAYOUT: 'seller_payout',
  AGENT_PAYOUT: 'agent_payout',
  SELLER_NET_HELD: 'seller_net_held',
  SELLER_NET_RELEASED: 'seller_net_released',
  SELLER_NET_REVERSED: 'seller_net_reversed',
  COMMISSION_REVERSED: 'commission_reversed',
  RETURN_FEE_CHARGED: 'return_fee_charged',
  RETURN_FEE_EARNED: 'return_fee_earned',
  CUSTOMER_REFUND_OWED: 'customer_refund_owed',
  CUSTOMER_REFUND_PAID: 'customer_refund_paid',
  PROMOTION_FUNDED: 'promotion_funded',
  PROMOTION_REVERSED: 'promotion_reversed',
} as const;
export type EntryType = (typeof EntryType)[keyof typeof EntryType];

/** Values match `chk_ledger_entries_reference_type` (D-12, spec 12 §8.1). */
export const ReferenceType = {
  SELLER_ORDER: 'seller_order',
  ORDER: 'order',
  COD_REMITTANCE: 'cod_remittance',
  PAYOUT: 'payout',
  RETURN: 'return',
  REFUND: 'refund',
  SELLER_ORDER_HOLD: 'seller_order_hold',
} as const;
export type ReferenceType = (typeof ReferenceType)[keyof typeof ReferenceType];

/** Values match `chk_payouts_payee_type` (spec 12 §1.3). */
export const PayeeType = {
  SELLER: 'seller',
  AGENT: 'agent',
} as const;
export type PayeeType = (typeof PayeeType)[keyof typeof PayeeType];
