import { type Knex } from 'knex';

// cart: one line per variant (spec 08 §1). Only variant + quantity: prices, names and stock are
// always read live. The max of CART_MAX_LINES lines per cart is enforced by the app under the cart
// row lock (spec 08 CT-2, CT-9).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE cart_items (
      id         UUID        NOT NULL DEFAULT uuidv7(),
      cart_id    UUID        NOT NULL,
      variant_id UUID        NOT NULL,
      quantity   INTEGER     NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_cart_items PRIMARY KEY (id),
      CONSTRAINT fk_cart_items_cart_id FOREIGN KEY (cart_id) REFERENCES carts (id) ON DELETE CASCADE,
      -- Cross-module FK (D12). No index: nothing looks lines up by variant, and variants are only
      -- soft-deleted, so the RESTRICT check never runs (02-database.md §7, P4-Q11).
      CONSTRAINT fk_cart_items_variant_id
        FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE RESTRICT,
      -- One line per variant, and the items of my cart: WHERE cart_id = ? (≤ CART_MAX_LINES rows,
      -- so the ORDER BY created_at, id is cheap).
      CONSTRAINT uq_cart_items_cart_id_variant_id UNIQUE (cart_id, variant_id),
      -- DB-Q3; mirrors CART_MAX_LINE_QUANTITY.
      CONSTRAINT chk_cart_items_quantity CHECK (quantity BETWEEN 1 AND 99)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS cart_items`);
}
