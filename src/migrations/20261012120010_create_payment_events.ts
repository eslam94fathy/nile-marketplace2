import { type Knex } from 'knex';

// payments: webhook inbox (spec 10 UC-PA-1). Only signature-verified webhooks are stored (PA-7);
// the unique provider event id dedupes Kashier's retries.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE payment_events (
      id                UUID         NOT NULL DEFAULT uuidv7(),
      -- null when the webhook names no known payment (KASHIER_UNKNOWN_ORDER)
      payment_id        UUID         NULL,
      provider          VARCHAR(20)  NOT NULL,
      provider_event_id VARCHAR(100) NOT NULL,
      event_type        VARCHAR(50)  NOT NULL,
      -- Card data and secrets stripped before insert.
      payload           JSONB        NOT NULL,
      signature_valid   BOOLEAN      NOT NULL,
      processed_at      TIMESTAMPTZ  NULL,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_payment_events PRIMARY KEY (id),
      CONSTRAINT fk_payment_events_payment_id FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE RESTRICT,
      -- Webhook dedupe: INSERT … ON CONFLICT (provider, provider_event_id) DO NOTHING
      CONSTRAINT uq_payment_events_provider_provider_event_id UNIQUE (provider, provider_event_id),
      CONSTRAINT chk_payment_events_provider CHECK (provider IN ('kashier')),
      CONSTRAINT chk_payment_events_payload CHECK (jsonb_typeof(payload) = 'object')
    );

    -- Events of a payment (admin payment view, D-8): WHERE payment_id = ? ORDER BY created_at
    CREATE INDEX idx_payment_events_payment_id ON payment_events (payment_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS payment_events`);
}
