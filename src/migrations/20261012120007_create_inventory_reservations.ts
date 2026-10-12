import { type Knex } from 'knex';

// inventory: stock held for one order line (spec 07 UC-IN-1…3, IN-5). quantity is what is still
// reserved: a release lowers it, and a full release leaves 0 with status 'released' (UC-IN-2).
// A commit keeps the quantity it moved out of on_hand.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE inventory_reservations (
      id                UUID        NOT NULL DEFAULT uuidv7(),
      inventory_item_id UUID        NOT NULL,
      order_item_id     UUID        NOT NULL,
      quantity          INTEGER     NOT NULL,
      status            VARCHAR(20) NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_inventory_reservations PRIMARY KEY (id),
      -- No index: nothing looks reservations up by item, and items are never deleted (D-8).
      CONSTRAINT fk_inventory_reservations_inventory_item_id
        FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id) ON DELETE RESTRICT,
      -- Cross-module FK (D12).
      CONSTRAINT fk_inventory_reservations_order_item_id
        FOREIGN KEY (order_item_id) REFERENCES order_items (id) ON DELETE RESTRICT,
      -- One reservation per order line; also the release / commit lookup: WHERE order_item_id = ANY(?)
      CONSTRAINT uq_inventory_reservations_order_item_id UNIQUE (order_item_id),
      CONSTRAINT chk_inventory_reservations_status CHECK (status IN ('active', 'committed', 'released')),
      CONSTRAINT chk_inventory_reservations_quantity CHECK (quantity >= 0),
      -- Fully released ⇔ nothing left reserved.
      CONSTRAINT chk_inventory_reservations_released CHECK ((status = 'released') = (quantity = 0))
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS inventory_reservations`);
}
