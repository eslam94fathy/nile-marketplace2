import { type Knex } from 'knex';

// ordering: append-only record of every partial item cancellation by a seller (spec 09 §3.5).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE order_item_cancellations (
      id            UUID         NOT NULL DEFAULT uuidv7(),
      order_item_id UUID         NOT NULL,
      quantity      INTEGER      NOT NULL,
      reason        VARCHAR(40)  NOT NULL,
      note          VARCHAR(500) NULL,
      -- Always the seller's user (item cancellation is seller-only, Q-31).
      actor_user_id UUID         NOT NULL,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_order_item_cancellations PRIMARY KEY (id),
      CONSTRAINT fk_order_item_cancellations_order_item_id
        FOREIGN KEY (order_item_id) REFERENCES order_items (id) ON DELETE RESTRICT,
      -- Audit pointer, never a lookup path: no index.
      CONSTRAINT fk_order_item_cancellations_actor_user_id
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_order_item_cancellations_quantity CHECK (quantity > 0),
      CONSTRAINT chk_order_item_cancellations_reason CHECK (reason IN ('out_of_stock', 'seller_request', 'other')),
      -- spec 09 §4.2: a note is required when the reason is 'other'.
      CONSTRAINT chk_order_item_cancellations_note CHECK (reason <> 'other' OR note IS NOT NULL)
    );

    -- Cancellations of order lines: WHERE order_item_id = ANY(?)
    CREATE INDEX idx_order_item_cancellations_order_item_id ON order_item_cancellations (order_item_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS order_item_cancellations`);
}
