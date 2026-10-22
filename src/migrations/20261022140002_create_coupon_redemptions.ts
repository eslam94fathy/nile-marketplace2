import { type Knex } from 'knex';

// promotions: one redemption per order that used a coupon (spec 19 UC-PR-2, UC-PR-3, database v2.0
// §14.10, D-26). Written in the checkout transaction after the order rows, released by the close step.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE coupon_redemptions (
      id             UUID          NOT NULL DEFAULT uuidv7(),
      coupon_id      UUID          NOT NULL,
      customer_id    UUID          NOT NULL,
      order_id       UUID          NOT NULL,
      discount_total NUMERIC(12,2) NOT NULL,
      status         VARCHAR(10)   NOT NULL,
      released_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_coupon_redemptions PRIMARY KEY (id),
      -- One coupon per checkout; also the release lookup by order.
      CONSTRAINT uq_coupon_redemptions_order_id UNIQUE (order_id),
      CONSTRAINT fk_coupon_redemptions_coupon_id
        FOREIGN KEY (coupon_id) REFERENCES coupons (id) ON DELETE RESTRICT,
      -- Customers are never hard-deleted: unindexed by design (D-26).
      CONSTRAINT fk_coupon_redemptions_customer_id
        FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
      CONSTRAINT fk_coupon_redemptions_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
      CONSTRAINT chk_coupon_redemptions_discount_total CHECK (discount_total >= 0),
      CONSTRAINT chk_coupon_redemptions_status CHECK (status IN ('active', 'released')),
      CONSTRAINT chk_coupon_redemptions_released CHECK ((status = 'released') = (released_at IS NOT NULL))
    );

    -- Per-customer limit (UC-PR-2 step 2, §3.1): SELECT count(*) WHERE coupon_id = ? AND customer_id = ?
    -- AND status = 'active'.
    CREATE INDEX idx_coupon_redemptions_coupon_id_customer_id
      ON coupon_redemptions (coupon_id, customer_id) WHERE status = 'active';

    -- Admin coupon detail (spec 19 §4.3): WHERE coupon_id = ? ORDER BY created_at DESC LIMIT 50.
    CREATE INDEX idx_coupon_redemptions_coupon_id_created_at
      ON coupon_redemptions (coupon_id, created_at DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS coupon_redemptions`);
}
