import { type Knex } from 'knex';

// finance: the holding period, return and refund bookings (spec 12 §8.1, database v2.0 §14.13). The
// promotion entry types come with coupons (FI-16). The CHECKs are replaced NOT VALID on the append-only
// ledger and validated by the next migration (database §14.2).
const R1_ENTRY_TYPES = `'seller_net_earned', 'commission_earned', 'agent_fee_earned', 'platform_fee_earned',
  'cod_cash_collected', 'cod_cash_remitted', 'seller_payout', 'agent_payout'`;
const R2_ENTRY_TYPES = `'seller_net_held', 'seller_net_released', 'seller_net_reversed', 'commission_reversed',
  'return_fee_charged', 'return_fee_earned', 'customer_refund_owed', 'customer_refund_paid'`;
const R1_REFERENCE_TYPES = `'seller_order', 'order', 'cod_remittance', 'payout'`;
const R2_REFERENCE_TYPES = `'return', 'refund', 'seller_order_hold'`;

const replaceChecks = (entryTypes: string, referenceTypes: string) => `
  ALTER TABLE ledger_entries
    DROP CONSTRAINT chk_ledger_entries_entry_type,
    DROP CONSTRAINT chk_ledger_entries_reference_type;
  ALTER TABLE ledger_entries
    ADD CONSTRAINT chk_ledger_entries_entry_type CHECK (entry_type IN (${entryTypes})) NOT VALID,
    ADD CONSTRAINT chk_ledger_entries_reference_type CHECK (reference_type IN (${referenceTypes})) NOT VALID;
`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    replaceChecks(`${R1_ENTRY_TYPES}, ${R2_ENTRY_TYPES}`, `${R1_REFERENCE_TYPES}, ${R2_REFERENCE_TYPES}`),
  );
}

export async function down(knex: Knex): Promise<void> {
  // NOT VALID and left so: entries of the new types written meanwhile stay (the ledger is append-only).
  await knex.raw(replaceChecks(R1_ENTRY_TYPES, R1_REFERENCE_TYPES));
}
