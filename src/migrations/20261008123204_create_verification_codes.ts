import { type Knex } from 'knex';

// identity: hashed OTPs (email verification, password reset) and invite tokens.
// Append-only except `attempts` and `consumed_at`. The plain code is never stored.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE verification_codes (
      id          UUID         NOT NULL DEFAULT uuidv7(),
      user_id     UUID         NOT NULL,
      purpose     VARCHAR(30)  NOT NULL,
      code_hash   CHAR(64)     NOT NULL,
      expires_at  TIMESTAMPTZ  NOT NULL,
      attempts    SMALLINT     NOT NULL,
      consumed_at TIMESTAMPTZ  NULL,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_verification_codes PRIMARY KEY (id),
      CONSTRAINT fk_verification_codes_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT chk_verification_codes_purpose
        CHECK (purpose IN ('email_verification', 'password_reset', 'account_invite')),
      CONSTRAINT chk_verification_codes_code_hash_hex CHECK (code_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT chk_verification_codes_attempts CHECK (attempts >= 0)
    );

    -- Latest active code of a user for a purpose (verify, resend cooldown):
    -- WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1
    CREATE INDEX idx_verification_codes_user_id_purpose_created_at
      ON verification_codes (user_id, purpose, created_at DESC)
      WHERE consumed_at IS NULL;

    -- Invite link: WHERE code_hash = ? AND purpose = 'account_invite'
    CREATE UNIQUE INDEX uq_verification_codes_code_hash
      ON verification_codes (code_hash)
      WHERE purpose = 'account_invite';

    -- Retention cleanup scans this small table (one row per OTP/invite) without an index.
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS verification_codes`);
}
