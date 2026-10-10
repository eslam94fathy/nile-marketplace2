import { type Knex } from 'knex';

// inventory: append-only audit of every stock change (spec 07 §2), written in the same
// transaction as the change.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE inventory_movements (
      id                UUID        NOT NULL DEFAULT uuidv7(),
      inventory_item_id UUID        NOT NULL,
      type              VARCHAR(30) NOT NULL,
      quantity_delta    INTEGER     NOT NULL,
      on_hand_after     INTEGER     NOT NULL,
      reserved_after    INTEGER     NOT NULL,
      -- What caused it (e.g. an order item, P5); null for seller adjustments.
      reference_type    VARCHAR(30) NULL,
      reference_id      UUID        NULL,
      -- null = system
      actor_user_id     UUID        NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_inventory_movements PRIMARY KEY (id),
      CONSTRAINT fk_inventory_movements_inventory_item_id
        FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id) ON DELETE RESTRICT,
      -- Audit pointer, never a lookup path: no index.
      CONSTRAINT fk_inventory_movements_actor_user_id
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_inventory_movements_type
        CHECK (type IN ('seller_adjustment', 'reserve', 'release', 'commit'))
    );

    -- Seller stock history, cursor-paginated (D-6):
    -- WHERE inventory_item_id = ? ORDER BY created_at DESC, id DESC
    CREATE INDEX idx_inventory_movements_inventory_item_id_created_at_id
      ON inventory_movements (inventory_item_id, created_at DESC, id DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS inventory_movements`);
}
