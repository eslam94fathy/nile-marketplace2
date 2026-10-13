import { type Knex } from 'knex';

// notifications: one row per transactional email attempt that reached a final state (sent / failed).
// Never holds the OTP or the invite link (spec 13 UC-NO-1 step 4).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE notification_log (
      id                  UUID          NOT NULL DEFAULT uuidv7(),
      user_id             UUID          NULL,
      template            VARCHAR(50)   NOT NULL,
      to_email            VARCHAR(254)  NOT NULL,
      status              VARCHAR(20)   NOT NULL,
      provider_message_id VARCHAR(100)  NULL,
      error               VARCHAR(2000) NULL,
      source_event_id     UUID          NOT NULL,
      created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_notification_log PRIMARY KEY (id),
      -- Nullable: the log outlives the user row (support history).
      CONSTRAINT fk_notification_log_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
      CONSTRAINT chk_notification_log_template
        CHECK (template IN ('email_verification', 'password_reset', 'account_invite')),
      CONSTRAINT chk_notification_log_status CHECK (status IN ('sent', 'failed')),
      CONSTRAINT chk_notification_log_error_on_failure CHECK (status = 'sent' OR error IS NOT NULL)
    );

    -- Dedupe on redelivery: WHERE source_event_id = ? (never send the same email twice).
    CREATE UNIQUE INDEX uq_notification_log_source_event_id ON notification_log (source_event_id);

    -- Support lookup: WHERE user_id = ? ORDER BY created_at DESC
    CREATE INDEX idx_notification_log_user_id_created_at ON notification_log (user_id, created_at DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS notification_log`);
}
