import { type Knex } from 'knex';

// sellers: append-only audit of per-seller commission changes (spec 05 UC-SE-3).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE seller_commission_history (
      id                 UUID         NOT NULL DEFAULT uuidv7(),
      seller_id          UUID         NOT NULL,
      old_rate           NUMERIC(5,4) NOT NULL,
      new_rate           NUMERIC(5,4) NOT NULL,
      changed_by_user_id UUID         NOT NULL,
      created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_seller_commission_history PRIMARY KEY (id),
      CONSTRAINT fk_seller_commission_history_seller_id
        FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE RESTRICT,
      -- Audit pointer, never a lookup path: no index.
      CONSTRAINT fk_seller_commission_history_changed_by_user_id
        FOREIGN KEY (changed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_seller_commission_history_old_rate CHECK (old_rate BETWEEN 0 AND 1),
      CONSTRAINT chk_seller_commission_history_new_rate CHECK (new_rate BETWEEN 0 AND 1)
    );

    -- Admin audit view: WHERE seller_id = ? ORDER BY created_at DESC LIMIT 50
    CREATE INDEX idx_seller_commission_history_seller_id_created_at
      ON seller_commission_history (seller_id, created_at DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS seller_commission_history`);
}
