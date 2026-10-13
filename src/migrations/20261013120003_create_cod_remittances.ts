import { type Knex } from 'knex';

// finance: COD cash an agent handed to the platform, confirmed by an admin (spec 12 §1.3, Q-18).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE cod_remittances (
      id                   UUID           NOT NULL DEFAULT uuidv7(),
      agent_id             UUID           NOT NULL,
      amount               NUMERIC(12,2)  NOT NULL,
      confirmed_by_user_id UUID           NOT NULL,
      note                 VARCHAR(500)   NULL,
      -- Cursor-sorted by the remittance lists (D-11, D-12).
      created_at           TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      CONSTRAINT pk_cod_remittances PRIMARY KEY (id),
      -- Backstop for the agent lookup that runs first (spec 12 FI-5).
      CONSTRAINT fk_cod_remittances_agent_id
        FOREIGN KEY (agent_id) REFERENCES delivery_agents (id) ON DELETE RESTRICT,
      -- Audit pointer, never a lookup path: no index (D-12).
      CONSTRAINT fk_cod_remittances_confirmed_by_user_id
        FOREIGN KEY (confirmed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_cod_remittances_amount CHECK (amount > 0)
    );

    -- One agent's remittances (admin filter, GET /agent/finance/remittances):
    -- WHERE agent_id = ? ORDER BY created_at DESC, id DESC (D-12).
    CREATE INDEX idx_cod_remittances_agent_id_created_at_id
      ON cod_remittances (agent_id, created_at DESC, id DESC);

    -- Unfiltered admin list: ORDER BY created_at DESC, id DESC (D-12).
    CREATE INDEX idx_cod_remittances_created_at_id ON cod_remittances (created_at DESC, id DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS cod_remittances`);
}
