import { type Knex } from 'knex';

// identity: rotating refresh tokens, stored hashed; reuse revokes the family (architecture §10).
// Append-only except `revoked_at` (set once) and `replaced_by_id`.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE refresh_tokens (
      id             UUID          NOT NULL DEFAULT uuidv7(),
      user_id        UUID          NOT NULL,
      family_id      UUID          NOT NULL,
      token_hash     CHAR(64)      NOT NULL,
      expires_at     TIMESTAMPTZ   NOT NULL,
      revoked_at     TIMESTAMPTZ   NULL,
      replaced_by_id UUID          NULL,
      user_agent     VARCHAR(255)  NULL,
      created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_refresh_tokens PRIMARY KEY (id),
      CONSTRAINT fk_refresh_tokens_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      -- Audit pointer to the token that replaced this one. SET NULL so the retention cleanup can delete
      -- old rows of a family in any order.
      CONSTRAINT fk_refresh_tokens_replaced_by_id FOREIGN KEY (replaced_by_id)
        REFERENCES refresh_tokens (id) ON DELETE SET NULL,
      CONSTRAINT chk_refresh_tokens_token_hash_hex CHECK (token_hash ~ '^[0-9a-f]{64}$')
    );

    -- Refresh: SELECT … WHERE token_hash = ?
    CREATE UNIQUE INDEX uq_refresh_tokens_token_hash ON refresh_tokens (token_hash);

    -- Reuse detected: UPDATE … SET revoked_at = now() WHERE family_id = ? AND revoked_at IS NULL
    CREATE INDEX idx_refresh_tokens_family_id ON refresh_tokens (family_id);

    -- Suspend / password reset / password change: revoke all live sessions of a user
    -- (UPDATE … WHERE user_id = ? AND revoked_at IS NULL)
    CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

    -- Retention cleanup (expired-codes-cleanup job): DELETE … WHERE expires_at < now() - retention.
    -- Every refresh adds a row, so this table is large; proposed as D-4 (not yet in 02-database.md).
    CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS refresh_tokens`);
}
