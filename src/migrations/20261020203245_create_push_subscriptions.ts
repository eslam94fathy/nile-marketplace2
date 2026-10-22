import { type Knex } from 'knex';

// notifications: browsers registered for Web Push (spec 13 §8.1, UC-NO-4, database v2.0 §14.6). At most
// 10 per user (a constant, enforced under the user's rows' order); the endpoint is unique.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE push_subscriptions (
      id              UUID          NOT NULL DEFAULT uuidv7(),
      user_id         UUID          NOT NULL,
      endpoint        VARCHAR(2048) NOT NULL,
      p256dh          VARCHAR(100)  NOT NULL,
      auth            VARCHAR(50)   NOT NULL,
      -- Optional label the browser sends (which device this is).
      user_agent      VARCHAR(200),
      -- Null until a push to it succeeded.
      last_success_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_push_subscriptions PRIMARY KEY (id),
      CONSTRAINT fk_push_subscriptions_user_id
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
      -- The upsert target: a browser that switches accounts moves its subscription (UC-NO-4).
      CONSTRAINT uq_push_subscriptions_endpoint UNIQUE (endpoint),
      CONSTRAINT chk_push_subscriptions_endpoint CHECK (endpoint LIKE 'https://%')
    );

    -- A user's subscriptions, oldest first: the sender's list, the 10-per-user trim and the
    -- delete-all on suspension / password reset (WHERE user_id = ? ORDER BY created_at, id).
    CREATE INDEX idx_push_subscriptions_user_id_created_at ON push_subscriptions (user_id, created_at, id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS push_subscriptions`);
}
