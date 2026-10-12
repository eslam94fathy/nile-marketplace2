import { type Knex } from 'knex';

// ordering: one line per variant of a seller order, with the product snapshot taken at checkout
// (spec 09 §3.1). Partial cancellations raise cancelled_quantity and recompute line_total (§3.5).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE order_items (
      id                 UUID          NOT NULL DEFAULT uuidv7(),
      seller_order_id    UUID          NOT NULL,
      variant_id         UUID          NOT NULL,
      product_id         UUID          NOT NULL,
      product_name       VARCHAR(200)  NOT NULL,
      sku                VARCHAR(64)   NOT NULL,
      -- [{ "attribute": "Size", "value": "XL" }]
      variant_attributes JSONB         NOT NULL,
      unit_price         NUMERIC(12,2) NOT NULL,
      quantity           INTEGER       NOT NULL,
      cancelled_quantity INTEGER       NOT NULL,
      line_total         NUMERIC(12,2) NOT NULL,
      created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_order_items PRIMARY KEY (id),
      CONSTRAINT fk_order_items_seller_order_id
        FOREIGN KEY (seller_order_id) REFERENCES seller_orders (id) ON DELETE RESTRICT,
      -- Cross-module FKs (D12). No indexes: nothing looks order lines up by variant or product, and
      -- both are only soft-deleted, so the RESTRICT checks never run (02-database.md §8, D-8).
      CONSTRAINT fk_order_items_variant_id
        FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE RESTRICT,
      CONSTRAINT fk_order_items_product_id FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
      CONSTRAINT chk_order_items_variant_attributes CHECK (jsonb_typeof(variant_attributes) = 'array'),
      CONSTRAINT chk_order_items_unit_price CHECK (unit_price > 0),
      -- Mirrors the cart's per-line limit (DB-Q3).
      CONSTRAINT chk_order_items_quantity CHECK (quantity BETWEEN 1 AND 99),
      CONSTRAINT chk_order_items_cancelled_quantity CHECK (cancelled_quantity BETWEEN 0 AND quantity),
      CONSTRAINT chk_order_items_line_total CHECK (line_total = unit_price * (quantity - cancelled_quantity))
    );

    -- Items of seller orders: WHERE seller_order_id = ANY(?)
    CREATE INDEX idx_order_items_seller_order_id ON order_items (seller_order_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS order_items`);
}
