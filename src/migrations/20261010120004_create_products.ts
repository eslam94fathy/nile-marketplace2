import { type Knex } from 'knex';

// catalog: seller products (soft delete). seller_active, min_price, max_price and in_stock are
// listing projections kept by catalog, so public lists never join across modules (spec 06 UC-CA-7).
// VIS (the public "visible" predicate of every public partial index):
//   status = 'active' AND seller_active AND deleted_at IS NULL
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE products (
      id            UUID          NOT NULL DEFAULT uuidv7(),
      seller_id     UUID          NOT NULL,
      category_id   UUID          NOT NULL,
      name          VARCHAR(200)  NOT NULL,
      slug          VARCHAR(220)  NOT NULL,
      description   TEXT          NOT NULL,
      status        VARCHAR(20)   NOT NULL,
      -- Projection of the seller's status (= approved), kept by the seller-status consumer.
      seller_active BOOLEAN       NOT NULL,
      -- Lowest / highest active variant price; null = no active variant.
      min_price     NUMERIC(12,2) NULL,
      max_price     NUMERIC(12,2) NULL,
      -- Projection: any active variant with sellable stock > 0.
      in_stock      BOOLEAN       NOT NULL,
      search_vector TSVECTOR      GENERATED ALWAYS AS (
                      setweight(to_tsvector('english', name), 'A') ||
                      setweight(to_tsvector('english', description), 'B')
                    ) STORED,
      published_at  TIMESTAMPTZ   NULL,
      deleted_at    TIMESTAMPTZ   NULL,
      created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_products PRIMARY KEY (id),
      -- Cross-module FK (D12). Lookups by seller use idx_products_seller_id_created_at_id.
      CONSTRAINT fk_products_seller_id FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE RESTRICT,
      CONSTRAINT fk_products_category_id FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT,
      -- Product detail by slug (immutable, carries a random suffix).
      CONSTRAINT uq_products_slug UNIQUE (slug),
      CONSTRAINT chk_products_status CHECK (status IN ('draft', 'active', 'inactive')),
      CONSTRAINT chk_products_description CHECK (char_length(description) <= 5000),
      CONSTRAINT chk_products_min_price CHECK (min_price >= 0),
      CONSTRAINT chk_products_max_price CHECK (max_price >= min_price)
    );

    -- Category listing, newest first (D-5):
    -- WHERE VIS AND category_id = ANY(?) ORDER BY published_at DESC, id DESC
    CREATE INDEX idx_products_category_id_published_at_id
      ON products (category_id, published_at DESC, id DESC)
      WHERE status = 'active' AND seller_active AND deleted_at IS NULL;

    -- Category listing sorted or filtered by price:
    -- WHERE VIS AND category_id = ANY(?) [AND min_price BETWEEN ? AND ?] ORDER BY min_price, id
    CREATE INDEX idx_products_category_id_min_price_id
      ON products (category_id, min_price, id)
      WHERE status = 'active' AND seller_active AND deleted_at IS NULL;

    -- Listing without a category filter (D-5): WHERE VIS ORDER BY published_at DESC, id DESC
    CREATE INDEX idx_products_published_at_id
      ON products (published_at DESC, id DESC)
      WHERE status = 'active' AND seller_active AND deleted_at IS NULL;

    -- Full-text search: WHERE VIS AND search_vector @@ websearch_to_tsquery('english', ?)
    CREATE INDEX idx_products_search_vector
      ON products USING GIN (search_vector)
      WHERE status = 'active' AND seller_active AND deleted_at IS NULL;

    -- Typo-tolerant / partial-word search: WHERE VIS AND name % ?
    CREATE INDEX idx_products_name_trgm
      ON products USING GIN (name gin_trgm_ops)
      WHERE status = 'active' AND seller_active AND deleted_at IS NULL;

    -- Category usage checks outside VIS (D-7): deactivate a category, add/delete an attribute in a
    -- subtree, PRODUCT_CATEGORY_LOCKED: EXISTS (... WHERE category_id = ANY(?) [AND deleted_at IS NULL]).
    -- Also indexes the FK.
    CREATE INDEX idx_products_category_id ON products (category_id);

    -- Seller dashboard: WHERE seller_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC.
    -- Also serves the projection update WHERE seller_id = ?.
    CREATE INDEX idx_products_seller_id_created_at_id
      ON products (seller_id, created_at DESC, id DESC)
      WHERE deleted_at IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS products`);
}
