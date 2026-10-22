import { type Knex } from 'knex';

// finance: the coupon bookings, rows 8 and 11 (spec 12 §8.2, §8.4, FI-20). The CHECK is replaced NOT VALID
// on the append-only ledger and validated by the next migration (database §14.2). No new reference type.
const EARLIER_ENTRY_TYPES = `'seller_net_earned', 'commission_earned', 'agent_fee_earned', 'platform_fee_earned',
  'cod_cash_collected', 'cod_cash_remitted', 'seller_payout', 'agent_payout',
  'seller_net_held', 'seller_net_released', 'seller_net_reversed', 'commission_reversed',
  'return_fee_charged', 'return_fee_earned', 'customer_refund_owed', 'customer_refund_paid'`;

const replaceCheck = (entryTypes: string) => `
  ALTER TABLE ledger_entries DROP CONSTRAINT chk_ledger_entries_entry_type;
  ALTER TABLE ledger_entries
    ADD CONSTRAINT chk_ledger_entries_entry_type CHECK (entry_type IN (${entryTypes})) NOT VALID;
`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(replaceCheck(`${EARLIER_ENTRY_TYPES}, 'promotion_funded', 'promotion_reversed'`));
}

export async function down(knex: Knex): Promise<void> {
  // NOT VALID and left so: entries of the new types written meanwhile stay (the ledger is append-only).
  await knex.raw(replaceCheck(EARLIER_ENTRY_TYPES));
}
