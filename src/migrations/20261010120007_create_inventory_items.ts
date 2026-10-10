import { type Knex } from 'knex';

// inventory: stock per variant (spec 07). Sellable = on_hand - reserved. Every change is a
// conditional atomic update plus an inventory_movements row in the same transaction.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE inventory_items (
      id         UUID        NOT NULL DEFAULT uuidv7(),
      variant_id UUID        NOT NULL,
      on_hand    INTEGER     NOT NULL,
      reserved   INTEGER     NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_inventory_items PRIMARY KEY (id),
      -- Cross-module FK (D12).
      CONSTRAINT fk_inventory_items_variant_id
        FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE RESTRICT,
      -- Batched lookup WHERE variant_id = ANY(?) (catalog, cart, checkout); one row per variant.
      CONSTRAINT uq_inventory_items_variant_id UNIQUE (variant_id),
      CONSTRAINT chk_inventory_items_on_hand CHECK (on_hand >= 0),
      CONSTRAINT chk_inventory_items_reserved CHECK (reserved >= 0),
      CONSTRAINT chk_inventory_items_reserved_lte_on_hand CHECK (reserved <= on_hand)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS inventory_items`);
}
