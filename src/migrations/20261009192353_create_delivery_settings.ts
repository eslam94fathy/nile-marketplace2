import { type Knex } from 'knex';

// delivery: global settings, exactly one row (02-database.md §10). The agent's share of the
// delivery fee is snapshotted on each order at checkout (Q-23b, Q-34), so changes affect new orders only.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE delivery_settings (
      id                   UUID         NOT NULL DEFAULT uuidv7(),
      is_singleton         BOOLEAN      NOT NULL,
      agent_fee_share_rate NUMERIC(5,4) NOT NULL,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_delivery_settings PRIMARY KEY (id),
      -- Only TRUE is allowed and it is unique, so the table can never hold a second row.
      CONSTRAINT uq_delivery_settings_is_singleton UNIQUE (is_singleton),
      CONSTRAINT chk_delivery_settings_is_singleton CHECK (is_singleton),
      CONSTRAINT chk_delivery_settings_agent_fee_share_rate
        CHECK (agent_fee_share_rate BETWEEN 0 AND 1)
    );

    INSERT INTO delivery_settings (is_singleton, agent_fee_share_rate) VALUES (TRUE, 0.7000);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS delivery_settings`);
}
