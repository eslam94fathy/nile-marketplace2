import { type Knex } from 'knex';

// ordering: append-only record of the units of an order line returned by one return, with their amounts
// (spec 09 §8.7, database v2.0 §14.11). Written by recordReturn inside the returns transaction (UC-RE-7).
// discount_amount stays 0 until coupons (R2-P7, OR-27).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE order_item_returns (
      id                UUID          NOT NULL DEFAULT uuidv7(),
      return_id         UUID          NOT NULL,
      order_item_id     UUID          NOT NULL,
      quantity          SMALLINT      NOT NULL,
      subtotal_amount   NUMERIC(12,2) NOT NULL,
      discount_amount   NUMERIC(12,2) NOT NULL,
      paid_amount       NUMERIC(12,2) NOT NULL,
      commission_amount NUMERIC(12,2) NOT NULL,
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_order_item_returns PRIMARY KEY (id),
      -- Cross-module FK (D12), checked at commit so ordering may write before returns updates its row in
      -- the same transaction. Returns are never deleted and never looked up from here: no index.
      CONSTRAINT fk_order_item_returns_return_id FOREIGN KEY (return_id) REFERENCES return_requests (id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT fk_order_item_returns_order_item_id
        FOREIGN KEY (order_item_id) REFERENCES order_items (id) ON DELETE RESTRICT,
      CONSTRAINT chk_order_item_returns_quantity CHECK (quantity > 0),
      CONSTRAINT chk_order_item_returns_amounts CHECK (
        subtotal_amount >= 0 AND discount_amount >= 0 AND commission_amount >= 0
        AND paid_amount = subtotal_amount - discount_amount
      )
    );
    -- Returns of order lines: WHERE order_item_id = ANY(?)
    CREATE INDEX idx_order_item_returns_order_item_id ON order_item_returns (order_item_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS order_item_returns`);
}
