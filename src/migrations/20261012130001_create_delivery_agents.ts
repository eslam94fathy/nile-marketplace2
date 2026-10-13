import { type Knex } from 'knex';

// delivery: agents, created by admins with an invited login (spec 11 UC-DE-6). The availability
// toggle and the home governorate drive auto-assignment (overview §4.6, UC-DE-1).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE delivery_agents (
      id                  UUID         NOT NULL DEFAULT uuidv7(),
      user_id             UUID         NOT NULL,
      full_name           VARCHAR(100) NOT NULL,
      phone               VARCHAR(16)  NOT NULL,
      home_governorate_id UUID         NOT NULL,
      status              VARCHAR(20)  NOT NULL,
      on_shift            BOOLEAN      NOT NULL,
      last_assigned_at    TIMESTAMPTZ  NULL,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_delivery_agents PRIMARY KEY (id),
      -- Resolve the agent from the JWT sub: WHERE user_id = ? (one profile per user).
      CONSTRAINT uq_delivery_agents_user_id UNIQUE (user_id),
      CONSTRAINT fk_delivery_agents_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
      -- Governorates are never deleted; the candidate index below starts with this column.
      CONSTRAINT fk_delivery_agents_home_governorate_id
        FOREIGN KEY (home_governorate_id) REFERENCES governorates (id) ON DELETE RESTRICT,
      CONSTRAINT chk_delivery_agents_status CHECK (status IN ('active', 'inactive')),
      CONSTRAINT chk_delivery_agents_phone CHECK (phone ~ '^\\+[1-9][0-9]{6,14}$'),
      -- An inactive agent can't be on shift (UC-DE-2, UC-DE-6).
      CONSTRAINT chk_delivery_agents_on_shift CHECK (status = 'active' OR NOT on_shift)
    );

    -- Auto-assignment candidates (UC-DE-1): WHERE home_governorate_id = ? AND status = 'active' AND
    -- on_shift, the longest idle first (ties after the active-shipment count).
    CREATE INDEX idx_delivery_agents_home_governorate_id_last_assigned_at
      ON delivery_agents (home_governorate_id, last_assigned_at NULLS FIRST)
      WHERE status = 'active' AND on_shift;

    -- Admin agent list: ORDER BY created_at DESC, id DESC (D-10).
    CREATE INDEX idx_delivery_agents_created_at_id ON delivery_agents (created_at DESC, id DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS delivery_agents`);
}
