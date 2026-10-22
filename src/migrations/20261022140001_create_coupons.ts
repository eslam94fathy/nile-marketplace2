import { type Knex } from 'knex';

// promotions: coupon codes (spec 19 §1.1, PR-20, database v2.0 §14.10, D-26). Values match the
// promotions enums; no DB defaults on business columns (G13).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE coupons (
      id                 UUID           NOT NULL DEFAULT uuidv7(),
      -- Stored upper-case, so uniqueness is case-insensitive (spec 19 §1.1, PR-12).
      code               VARCHAR(32)    NOT NULL,
      funding            VARCHAR(10)    NOT NULL,
      seller_id          UUID,
      discount_type      VARCHAR(10)    NOT NULL,
      -- A rate (0.01..0.90) for percent, an EGP amount for fixed.
      discount_value     NUMERIC(12,4)  NOT NULL,
      max_discount       NUMERIC(12,2),
      min_items_subtotal NUMERIC(12,2)  NOT NULL,
      scope              VARCHAR(10)    NOT NULL,
      scope_seller_id    UUID,
      scope_category_id  UUID,
      starts_at          TIMESTAMPTZ    NOT NULL,
      ends_at            TIMESTAMPTZ    NOT NULL,
      -- NULL = unlimited.
      global_limit       INTEGER,
      per_customer_limit SMALLINT       NOT NULL,
      -- Active redemptions only: a release gives the use back (R-18).
      redemption_count   INTEGER        NOT NULL,
      status             VARCHAR(10)    NOT NULL,
      -- Set by the first redeem and never cleared: locks the fields (PR-8, PR-14).
      first_redeemed_at  TIMESTAMPTZ,
      admin_blocked_at   TIMESTAMPTZ,
      admin_block_reason VARCHAR(500),
      -- Cursor-sorted by the seller and admin lists (D-11).
      created_at         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ    NOT NULL DEFAULT now(),
      CONSTRAINT pk_coupons PRIMARY KEY (id),
      CONSTRAINT uq_coupons_code UNIQUE (code),
      -- Cross-module FKs (D12). seller_id is served by the seller list index; sellers and categories
      -- are never hard-deleted, so the scope FKs stay unindexed (D-26).
      CONSTRAINT fk_coupons_seller_id FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE RESTRICT,
      CONSTRAINT fk_coupons_scope_seller_id
        FOREIGN KEY (scope_seller_id) REFERENCES sellers (id) ON DELETE RESTRICT,
      CONSTRAINT fk_coupons_scope_category_id
        FOREIGN KEY (scope_category_id) REFERENCES categories (id) ON DELETE RESTRICT,
      CONSTRAINT chk_coupons_code CHECK (code ~ '^[A-Z0-9-]{4,32}$'),
      CONSTRAINT chk_coupons_funding CHECK (funding IN ('platform', 'seller')),
      CONSTRAINT chk_coupons_discount_type CHECK (discount_type IN ('percent', 'fixed')),
      CONSTRAINT chk_coupons_scope_values CHECK (scope IN ('all', 'seller', 'category')),
      CONSTRAINT chk_coupons_status CHECK (status IN ('active', 'inactive')),
      CONSTRAINT chk_coupons_funding_seller CHECK ((funding = 'seller') = (seller_id IS NOT NULL)),
      CONSTRAINT chk_coupons_discount_value CHECK (
        (discount_type = 'percent' AND discount_value BETWEEN 0.01 AND 0.90)
        OR (discount_type = 'fixed' AND discount_value > 0 AND discount_value = round(discount_value, 2))
      ),
      CONSTRAINT chk_coupons_max_discount
        CHECK (max_discount IS NULL OR (discount_type = 'percent' AND max_discount > 0)),
      CONSTRAINT chk_coupons_min_items_subtotal CHECK (min_items_subtotal >= 0),
      -- Each scope's ids; a seller-funded coupon only covers its own seller's products (spec 19 §1.1).
      CONSTRAINT chk_coupons_scope CHECK (
        (
          (scope = 'all' AND scope_seller_id IS NULL AND scope_category_id IS NULL)
          OR (scope = 'seller' AND scope_seller_id IS NOT NULL AND scope_category_id IS NULL)
          OR (scope = 'category' AND scope_category_id IS NOT NULL)
        )
        AND (
          (funding = 'platform' AND (scope <> 'category' OR scope_seller_id IS NULL))
          OR (funding = 'seller' AND scope IN ('seller', 'category') AND scope_seller_id = seller_id)
        )
      ),
      CONSTRAINT chk_coupons_dates CHECK (starts_at < ends_at),
      CONSTRAINT chk_coupons_limits CHECK (
        (global_limit IS NULL OR global_limit >= 1) AND per_customer_limit BETWEEN 1 AND 100
      ),
      CONSTRAINT chk_coupons_redemption_count CHECK (
        redemption_count >= 0 AND (global_limit IS NULL OR redemption_count <= global_limit)
        AND (redemption_count = 0 OR first_redeemed_at IS NOT NULL)
      ),
      -- PR-20: seller coupons only, both columns or neither, and a blocked coupon is inactive.
      CONSTRAINT chk_coupons_admin_block CHECK (
        (admin_blocked_at IS NULL) = (admin_block_reason IS NULL)
        AND (admin_blocked_at IS NULL OR (funding = 'seller' AND status = 'inactive'))
        AND (admin_block_reason IS NULL OR char_length(admin_block_reason) >= 3)
      )
    );

    -- GET /seller/coupons: WHERE seller_id = ? [AND status = ?] ORDER BY created_at DESC, id DESC (keyset).
    CREATE INDEX idx_coupons_seller_id_created_at_id
      ON coupons (seller_id, created_at DESC, id DESC) WHERE seller_id IS NOT NULL;

    -- GET /admin/coupons without a seller or code filter: ORDER BY created_at DESC, id DESC (keyset).
    CREATE INDEX idx_coupons_created_at_id ON coupons (created_at DESC, id DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS coupons`);
}
