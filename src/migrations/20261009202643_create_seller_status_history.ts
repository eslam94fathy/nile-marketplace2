import { type Knex } from 'knex';

// sellers: append-only audit of every status change, written in the same transaction (spec 05 §1).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE seller_status_history (
      id            UUID         NOT NULL DEFAULT uuidv7(),
      seller_id     UUID         NOT NULL,
      from_status   VARCHAR(20)  NULL,
      to_status     VARCHAR(20)  NOT NULL,
      reason        VARCHAR(500) NULL,
      -- null = system
      actor_user_id UUID         NULL,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_seller_status_history PRIMARY KEY (id),
      CONSTRAINT fk_seller_status_history_seller_id
        FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE RESTRICT,
      -- Audit pointer, never a lookup path: no index.
      CONSTRAINT fk_seller_status_history_actor_user_id
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_seller_status_history_from_status
        CHECK (from_status IS NULL OR from_status IN ('pending_approval', 'approved', 'rejected', 'suspended')),
      CONSTRAINT chk_seller_status_history_to_status
        CHECK (to_status IN ('pending_approval', 'approved', 'rejected', 'suspended'))
    );

    -- Admin audit view: WHERE seller_id = ? ORDER BY created_at DESC LIMIT 50
    CREATE INDEX idx_seller_status_history_seller_id_created_at
      ON seller_status_history (seller_id, created_at DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS seller_status_history`);
}
