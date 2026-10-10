import { type Knex } from 'knex';

// catalog: sellable variants of a product (soft delete), each with its own SKU, price and stock
// row in inventory (spec 06 UC-CA-4). seller_id is denormalized from the product for per-seller
// SKU uniqueness.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE product_variants (
      id               UUID          NOT NULL DEFAULT uuidv7(),
      product_id       UUID          NOT NULL,
      seller_id        UUID          NOT NULL,
      sku              VARCHAR(64)   NOT NULL,
      price            NUMERIC(12,2) NOT NULL,
      compare_at_price NUMERIC(12,2) NULL,
      status           VARCHAR(20)   NOT NULL,
      -- SHA-256 (hex) of the sorted option ids; of the empty string for the default variant.
      option_signature CHAR(64)      NOT NULL,
      -- The single variant of a product in a category without attributes [SD-7].
      is_default       BOOLEAN       NOT NULL,
      deleted_at       TIMESTAMPTZ   NULL,
      created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_product_variants PRIMARY KEY (id),
      CONSTRAINT fk_product_variants_product_id
        FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
      -- Cross-module FK (D12). Lookups by seller use uq_product_variants_seller_id_sku_lower.
      CONSTRAINT fk_product_variants_seller_id
        FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE RESTRICT,
      CONSTRAINT chk_product_variants_price CHECK (price > 0),
      CONSTRAINT chk_product_variants_compare_at_price
        CHECK (compare_at_price IS NULL OR compare_at_price > price),
      CONSTRAINT chk_product_variants_status CHECK (status IN ('active', 'inactive'))
    );

    -- Product detail and the min/max price recompute: WHERE product_id = ANY(?) AND deleted_at IS NULL
    CREATE INDEX idx_product_variants_product_id
      ON product_variants (product_id)
      WHERE deleted_at IS NULL;

    -- SKU unique per seller, case-insensitive, among live variants.
    CREATE UNIQUE INDEX uq_product_variants_seller_id_sku_lower
      ON product_variants (seller_id, lower(sku))
      WHERE deleted_at IS NULL;

    -- The same option combination can't exist twice on a product.
    CREATE UNIQUE INDEX uq_product_variants_product_id_option_signature
      ON product_variants (product_id, option_signature)
      WHERE deleted_at IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS product_variants`);
}
