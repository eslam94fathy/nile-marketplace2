import { type Knex } from 'knex';

// finance: platform_promotions, the platform's coupon cost (spec 12 §8.1, FI-14, FI-20, database v2.0
// §14.13). It only goes negative by design. One row per owner and type, so the table stays small: the
// CHECKs are swapped and validated here.
const EARLIER_TYPES = `'seller_payable', 'agent_fee_payable', 'agent_cod_cash',
  'platform_commission_revenue', 'platform_delivery_revenue', 'seller_pending', 'customer_refund_payable'`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE finance_accounts
      DROP CONSTRAINT chk_finance_accounts_account_type,
      DROP CONSTRAINT chk_finance_accounts_balance_non_negative;
    ALTER TABLE finance_accounts
      ADD CONSTRAINT chk_finance_accounts_account_type
        CHECK (account_type IN (${EARLIER_TYPES}, 'platform_promotions')),
      ADD CONSTRAINT chk_finance_accounts_balance_non_negative CHECK (
        account_type IN ('platform_delivery_revenue', 'platform_promotions', 'seller_payable') OR balance >= 0
      );
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Fails while a platform_promotions account exists: the schema can't hold it.
  await knex.raw(`
    ALTER TABLE finance_accounts
      DROP CONSTRAINT chk_finance_accounts_account_type,
      DROP CONSTRAINT chk_finance_accounts_balance_non_negative;
    ALTER TABLE finance_accounts
      ADD CONSTRAINT chk_finance_accounts_account_type CHECK (account_type IN (${EARLIER_TYPES})),
      ADD CONSTRAINT chk_finance_accounts_balance_non_negative
        CHECK (account_type IN ('platform_delivery_revenue', 'seller_payable') OR balance >= 0);
  `);
}
