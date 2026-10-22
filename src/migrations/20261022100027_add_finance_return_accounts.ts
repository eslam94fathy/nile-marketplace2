import { type Knex } from 'knex';

// finance: seller_pending and customer_refund_payable (spec 12 §8.1, database v2.0 §14.13); seller_payable
// may go negative now (FI-12). platform_promotions comes with coupons (FI-16). One row per owner and type,
// so the table stays small: the CHECKs are swapped and validated here.
const R1_TYPES = `'seller_payable', 'agent_fee_payable', 'agent_cod_cash',
  'platform_commission_revenue', 'platform_delivery_revenue'`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE finance_accounts
      DROP CONSTRAINT chk_finance_accounts_account_type,
      DROP CONSTRAINT chk_finance_accounts_balance_non_negative;
    ALTER TABLE finance_accounts
      ADD CONSTRAINT chk_finance_accounts_account_type
        CHECK (account_type IN (${R1_TYPES}, 'seller_pending', 'customer_refund_payable')),
      -- Delivery revenue (FI-1) and the seller's available balance (FI-12) may go negative; the app
      -- checks first (D-12).
      ADD CONSTRAINT chk_finance_accounts_balance_non_negative
        CHECK (account_type IN ('platform_delivery_revenue', 'seller_payable') OR balance >= 0);
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Fails while R2 accounts or a negative seller balance exist: the schema can't hold them.
  await knex.raw(`
    ALTER TABLE finance_accounts
      DROP CONSTRAINT chk_finance_accounts_account_type,
      DROP CONSTRAINT chk_finance_accounts_balance_non_negative;
    ALTER TABLE finance_accounts
      ADD CONSTRAINT chk_finance_accounts_account_type CHECK (account_type IN (${R1_TYPES})),
      ADD CONSTRAINT chk_finance_accounts_balance_non_negative
        CHECK (account_type = 'platform_delivery_revenue' OR balance >= 0);
  `);
}
