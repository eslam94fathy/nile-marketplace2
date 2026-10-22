import { type Knex } from 'knex';

// customers: the wishlist (spec 04 §8.1, R-12, database v2.0 §14.5). Products, not variants;
// append-only rows (an add is ON CONFLICT DO NOTHING, a remove deletes).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE wishlist_items (
      id          UUID           NOT NULL DEFAULT uuidv7(),
      customer_id UUID           NOT NULL,
      product_id  UUID           NOT NULL,
      created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      CONSTRAINT pk_wishlist_items PRIMARY KEY (id),
      -- One row per product; also the count under the customer lock and GET /me/wishlist/product-ids.
      CONSTRAINT uq_wishlist_items_customer_id_product_id UNIQUE (customer_id, product_id),
      CONSTRAINT fk_wishlist_items_customer_id
        FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
      -- Products are only soft-deleted, so this RESTRICT check never runs: no index on product_id.
      CONSTRAINT fk_wishlist_items_product_id
        FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT
    );

    -- GET /me/wishlist: WHERE customer_id = ? ORDER BY created_at DESC, id DESC (keyset).
    CREATE INDEX idx_wishlist_items_customer_id_created_at_id
      ON wishlist_items (customer_id, created_at DESC, id DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS wishlist_items;`);
}
