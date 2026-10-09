import { type Knex } from 'knex';

// sellers: global settings, exactly one row (02-database.md §4). The default commission applies to
// sellers who register after a change; existing sellers keep their own rate (spec 05 UC-SE-3).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE seller_settings (
      id                      UUID         NOT NULL DEFAULT uuidv7(),
      is_singleton            BOOLEAN      NOT NULL,
      default_commission_rate NUMERIC(5,4) NOT NULL,
      created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_seller_settings PRIMARY KEY (id),
      -- Only TRUE is allowed and it is unique, so the table can never hold a second row.
      CONSTRAINT uq_seller_settings_is_singleton UNIQUE (is_singleton),
      CONSTRAINT chk_seller_settings_is_singleton CHECK (is_singleton),
      CONSTRAINT chk_seller_settings_default_commission_rate
        CHECK (default_commission_rate BETWEEN 0 AND 1)
    );

    -- 10% when not set for a seller (CLAUDE.md §15).
    INSERT INTO seller_settings (is_singleton, default_commission_rate) VALUES (TRUE, 0.1000);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS seller_settings`);
}
