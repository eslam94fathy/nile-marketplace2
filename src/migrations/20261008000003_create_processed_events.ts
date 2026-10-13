import { type Knex } from 'knex';

// Consumer dedupe (docs/design/02-database.md §12, architecture §3.2). Owned by lib/events.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE processed_events (
      consumer     VARCHAR(100) NOT NULL,
      event_id     UUID         NOT NULL,
      processed_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
      -- Dedupe lookup/insert: (consumer, event_id). Composite PK allowed for dedupe tables (SD-8).
      CONSTRAINT pk_processed_events PRIMARY KEY (consumer, event_id)
    );

    -- Cleanup job: DELETE … WHERE processed_at < now() - retention
    CREATE INDEX idx_processed_events_processed_at ON processed_events (processed_at);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS processed_events`);
}
