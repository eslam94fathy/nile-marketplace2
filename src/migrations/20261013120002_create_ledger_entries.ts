import { type Knex } from 'knex';

// finance: the append-only ledger (spec 12 §1.2, §1.3). Each entry moves one account's balance and
// records the balance after it.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE ledger_entries (
      id              UUID           NOT NULL DEFAULT uuidv7(),
      account_id      UUID           NOT NULL,
      direction       VARCHAR(6)     NOT NULL,
      amount          NUMERIC(12,2)  NOT NULL,
      balance_after   NUMERIC(14,2)  NOT NULL,
      entry_type      VARCHAR(40)    NOT NULL,
      reference_type  VARCHAR(30)    NOT NULL,
      -- A seller order, order, remittance or payout depending on reference_type, so no FK.
      reference_id    UUID           NOT NULL,
      -- The consumed event; null for admin actions, which have no event.
      source_event_id UUID           NULL,
      -- Cursor-sorted by the statements (D-11, D-12).
      created_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      CONSTRAINT pk_ledger_entries PRIMARY KEY (id),
      CONSTRAINT fk_ledger_entries_account_id
        FOREIGN KEY (account_id) REFERENCES finance_accounts (id) ON DELETE RESTRICT,
      CONSTRAINT chk_ledger_entries_direction CHECK (direction IN ('credit', 'debit')),
      CONSTRAINT chk_ledger_entries_amount CHECK (amount > 0),
      CONSTRAINT chk_ledger_entries_entry_type CHECK (entry_type IN (
        'seller_net_earned', 'commission_earned', 'agent_fee_earned', 'platform_fee_earned',
        'cod_cash_collected', 'cod_cash_remitted', 'seller_payout', 'agent_payout'
      )),
      CONSTRAINT chk_ledger_entries_reference_type CHECK (reference_type IN (
        'seller_order', 'order', 'cod_remittance', 'payout'
      ))
    );

    -- Account statement: WHERE account_id = ? ORDER BY created_at DESC, id DESC (also the FK's
    -- lookup path).
    CREATE INDEX idx_ledger_entries_account_id_created_at_id
      ON ledger_entries (account_id, created_at DESC, id DESC);

    -- Money movements of one reference: WHERE reference_type = ? AND reference_id = ?
    CREATE INDEX idx_ledger_entries_reference_type_reference_id
      ON ledger_entries (reference_type, reference_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS ledger_entries`);
}
