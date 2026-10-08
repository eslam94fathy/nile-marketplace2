import { type Knex } from 'knex';

// Transactional outbox (docs/design/02-database.md §12). Owned by lib/events.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE events_outbox (
      id              UUID          NOT NULL DEFAULT uuidv7(),
      aggregate_type  VARCHAR(50)   NOT NULL,
      aggregate_id    UUID          NOT NULL,
      event_type      VARCHAR(100)  NOT NULL,
      event_version   SMALLINT      NOT NULL,
      payload         JSONB         NOT NULL,
      correlation_id  UUID          NULL,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
      dispatched_at   TIMESTAMPTZ   NULL,
      attempts        INTEGER       NOT NULL,
      next_attempt_at TIMESTAMPTZ   NOT NULL,
      last_error      VARCHAR(2000) NULL,
      CONSTRAINT pk_events_outbox PRIMARY KEY (id),
      CONSTRAINT chk_events_outbox_event_version CHECK (event_version >= 1),
      CONSTRAINT chk_events_outbox_attempts CHECK (attempts >= 0),
      CONSTRAINT chk_events_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object')
    );

    -- Drain scan: SELECT … WHERE dispatched_at IS NULL AND next_attempt_at <= now()
    --             ORDER BY next_attempt_at, id LIMIT n FOR UPDATE SKIP LOCKED
    CREATE INDEX idx_events_outbox_next_attempt_at_id
      ON events_outbox (next_attempt_at, id)
      WHERE dispatched_at IS NULL;

    -- Cleanup job: DELETE … WHERE dispatched_at < now() - retention
    CREATE INDEX idx_events_outbox_dispatched_at
      ON events_outbox (dispatched_at)
      WHERE dispatched_at IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS events_outbox`);
}
