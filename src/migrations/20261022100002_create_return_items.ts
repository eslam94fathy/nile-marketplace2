import { type Knex } from 'knex';

// returns: the order items and quantities of a request (spec 18 §1, database v2.0 §14.9). restock is the
// seller's choice at receipt; null until the return completes (the job and an admin restock nothing).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE return_items (
      id            UUID        NOT NULL DEFAULT uuidv7(),
      return_id     UUID        NOT NULL,
      order_item_id UUID        NOT NULL,
      quantity      SMALLINT    NOT NULL,
      restock       BOOLEAN,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_return_items PRIMARY KEY (id),
      CONSTRAINT fk_return_items_return_id
        FOREIGN KEY (return_id) REFERENCES return_requests (id) ON DELETE RESTRICT,
      -- Cross-module FK (D12). Order items are never deleted and never looked up from here: no index.
      CONSTRAINT fk_return_items_order_item_id
        FOREIGN KEY (order_item_id) REFERENCES order_items (id) ON DELETE RESTRICT,
      -- An item once per request; also the items of a page of requests: WHERE return_id = ANY(?).
      CONSTRAINT uq_return_items_return_id_order_item_id UNIQUE (return_id, order_item_id),
      CONSTRAINT chk_return_items_quantity CHECK (quantity BETWEEN 1 AND 99)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS return_items`);
}
