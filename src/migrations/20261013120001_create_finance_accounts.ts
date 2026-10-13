import { type Knex } from 'knex';

// finance: one balance per account (spec 12 §1.1). Every change is a ledger entry written in the same
// transaction, with the account row locked; the balance is the running sum (database §11).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE finance_accounts (
      id           UUID           NOT NULL DEFAULT uuidv7(),
      account_type VARCHAR(30)    NOT NULL,
      -- A seller id or an agent id depending on account_type (null for the platform accounts), so no
      -- FK: accounts are only created by a booking or an admin action that resolved the owner (D-12).
      owner_id     UUID           NULL,
      balance      NUMERIC(14,2)  NOT NULL,
      created_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
      -- Cursor-sorted by the admin account list (D-11, D-12).
      updated_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      CONSTRAINT pk_finance_accounts PRIMARY KEY (id),
      -- One account per type and owner; resolves an owner's account and backs the lazy
      -- INSERT … ON CONFLICT (account_type, owner_id) DO NOTHING (spec 12 FI-3).
      CONSTRAINT uq_finance_accounts_account_type_owner_id
        UNIQUE NULLS NOT DISTINCT (account_type, owner_id),
      CONSTRAINT chk_finance_accounts_account_type CHECK (account_type IN (
        'seller_payable', 'agent_fee_payable', 'agent_cod_cash',
        'platform_commission_revenue', 'platform_delivery_revenue'
      )),
      -- Only delivery revenue may go negative (spec 12 §1.1, FI-1); the app checks first (D-12).
      CONSTRAINT chk_finance_accounts_balance_non_negative
        CHECK (account_type = 'platform_delivery_revenue' OR balance >= 0)
    );

    -- Admin account list, default sort: ORDER BY balance DESC, id DESC (D-12).
    CREATE INDEX idx_finance_accounts_balance_id ON finance_accounts (balance DESC, id DESC);

    -- Admin account list sorted by updatedAt: ORDER BY updated_at DESC, id DESC (D-12).
    CREATE INDEX idx_finance_accounts_updated_at_id ON finance_accounts (updated_at DESC, id DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS finance_accounts`);
}
