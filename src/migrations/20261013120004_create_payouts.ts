import { type Knex } from 'knex';

// finance: payouts to sellers and agents, paid outside the system and recorded by an admin
// (spec 12 §1.3, Q-11, Q-38).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE payouts (
      id                  UUID           NOT NULL DEFAULT uuidv7(),
      payee_type          VARCHAR(20)    NOT NULL,
      -- A seller id or an agent id depending on payee_type, so no FK; the payee is resolved first
      -- (spec 12 FI-6, D-12).
      payee_id            UUID           NOT NULL,
      amount              NUMERIC(12,2)  NOT NULL,
      external_reference  VARCHAR(200)   NOT NULL,
      recorded_by_user_id UUID           NOT NULL,
      paid_at             TIMESTAMPTZ    NOT NULL,
      -- Cursor-sorted by the payout lists (D-11, D-12).
      created_at          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      CONSTRAINT pk_payouts PRIMARY KEY (id),
      -- Audit pointer, never a lookup path: no index (D-12).
      CONSTRAINT fk_payouts_recorded_by_user_id
        FOREIGN KEY (recorded_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      -- The same transfer is never recorded twice for one payee → 409 PAYOUT_ALREADY_RECORDED (FI-7).
      CONSTRAINT uq_payouts_payee_type_payee_id_external_reference
        UNIQUE (payee_type, payee_id, external_reference),
      CONSTRAINT chk_payouts_payee_type CHECK (payee_type IN ('seller', 'agent')),
      CONSTRAINT chk_payouts_amount CHECK (amount > 0)
    );

    -- One payee's payouts (admin filter, GET /seller/finance/payouts):
    -- WHERE payee_type = ? AND payee_id = ? ORDER BY created_at DESC, id DESC (D-12).
    CREATE INDEX idx_payouts_payee_type_payee_id_created_at_id
      ON payouts (payee_type, payee_id, created_at DESC, id DESC);

    -- Unfiltered admin list: ORDER BY created_at DESC, id DESC (D-12).
    CREATE INDEX idx_payouts_created_at_id ON payouts (created_at DESC, id DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS payouts`);
}
