import { type Knex } from 'knex';

// reviews: verified product reviews (spec 17 §1, database v2.0 §14.8, D-19). Soft delete: a deleted
// review keeps its row (and the seller's reply), and frees the customer to review the product again.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE product_reviews (
      id                UUID           NOT NULL DEFAULT uuidv7(),
      -- Snapshots of the delivered order item the review is based on (spec 17 UC-RV-1).
      product_id        UUID           NOT NULL,
      seller_id         UUID           NOT NULL,
      customer_id       UUID           NOT NULL,
      order_item_id     UUID           NOT NULL,
      variant_id        UUID           NOT NULL,
      -- The item's attributes, for display without a call to ordering (RV-10).
      variant_options   JSONB          NOT NULL,
      rating            SMALLINT       NOT NULL,
      -- Optional texts: a rating alone is a review.
      title             VARCHAR(120),
      body              TEXT,
      status            VARCHAR(20)    NOT NULL,
      -- Set exactly while hidden (chk_product_reviews_hidden).
      hidden_reason     VARCHAR(500),
      hidden_by_user_id UUID,
      hidden_at         TIMESTAMPTZ,
      edited_at         TIMESTAMPTZ,
      deleted_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
      CONSTRAINT pk_product_reviews PRIMARY KEY (id),
      CONSTRAINT fk_product_reviews_product_id
        FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
      CONSTRAINT fk_product_reviews_seller_id
        FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE RESTRICT,
      CONSTRAINT fk_product_reviews_customer_id
        FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
      CONSTRAINT fk_product_reviews_order_item_id
        FOREIGN KEY (order_item_id) REFERENCES order_items (id) ON DELETE RESTRICT,
      CONSTRAINT fk_product_reviews_variant_id
        FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE RESTRICT,
      CONSTRAINT fk_product_reviews_hidden_by_user_id
        FOREIGN KEY (hidden_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_product_reviews_rating CHECK (rating BETWEEN 1 AND 5),
      CONSTRAINT chk_product_reviews_title CHECK (title IS NULL OR char_length(title) >= 1),
      CONSTRAINT chk_product_reviews_body CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 2000),
      CONSTRAINT chk_product_reviews_status CHECK (status IN ('published', 'hidden')),
      CONSTRAINT chk_product_reviews_hidden CHECK (
        (status = 'hidden') = (hidden_reason IS NOT NULL)
        AND (status = 'hidden') = (hidden_by_user_id IS NOT NULL)
        AND (status = 'hidden') = (hidden_at IS NOT NULL)
      ),
      CONSTRAINT chk_product_reviews_hidden_reason
        CHECK (hidden_reason IS NULL OR char_length(hidden_reason) >= 3),
      CONSTRAINT chk_product_reviews_variant_options CHECK (jsonb_typeof(variant_options) = 'array')
    );

    -- One live review per customer and product (RV-1); a concurrent second one fails here (23505).
    -- Also "which of these products has the customer reviewed" (the reviewable list, RV-12).
    CREATE UNIQUE INDEX uq_product_reviews_customer_id_product_id
      ON product_reviews (customer_id, product_id) WHERE deleted_at IS NULL;

    -- GET /products/:productId/reviews: WHERE product_id = ? AND published AND live
    --   ORDER BY created_at DESC, id DESC (keyset); the rating filter / sort reads within one product.
    CREATE INDEX idx_product_reviews_product_id_created_at_id
      ON product_reviews (product_id, created_at DESC, id DESC)
      WHERE status = 'published' AND deleted_at IS NULL;

    -- GET /seller/reviews: WHERE seller_id = ? AND published AND live ORDER BY created_at DESC, id DESC.
    CREATE INDEX idx_product_reviews_seller_id_created_at_id
      ON product_reviews (seller_id, created_at DESC, id DESC)
      WHERE status = 'published' AND deleted_at IS NULL;

    -- GET /me/reviews: WHERE customer_id = ? AND live ORDER BY created_at DESC, id DESC.
    CREATE INDEX idx_product_reviews_customer_id_created_at_id
      ON product_reviews (customer_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

    -- GET /admin/reviews unfiltered: WHERE live ORDER BY created_at DESC, id DESC.
    CREATE INDEX idx_product_reviews_created_at_id
      ON product_reviews (created_at DESC, id DESC) WHERE deleted_at IS NULL;

    -- Unindexed FKs, by design: order_item_id, variant_id, hidden_by_user_id (no lookup by them; their
    -- parents are never deleted, so the RESTRICT checks never run).
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS product_reviews;`);
}
