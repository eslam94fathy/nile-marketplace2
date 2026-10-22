import { type Knex } from 'knex';

// ordering: the order's coupon and its discount (spec 09 §8.8, database v2.0 §14.11, D-26). The temporary
// default is dropped at once (DB-Q7). The FK and CHECK are NOT VALID and validated by the next migration
// (database §14.2). items_total stays the paid items total, so chk_orders_total is unchanged.
// orders.coupon_id is unindexed by design: coupons are never deleted (D-26).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE orders
      ADD COLUMN coupon_id      UUID,
      ADD COLUMN coupon_code    VARCHAR(32),
      ADD COLUMN discount_total NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ALTER COLUMN discount_total DROP DEFAULT;
    ALTER TABLE orders
      ADD CONSTRAINT fk_orders_coupon_id
        FOREIGN KEY (coupon_id) REFERENCES coupons (id) ON DELETE RESTRICT NOT VALID,
      ADD CONSTRAINT chk_orders_discount CHECK (
        discount_total >= 0
        AND (coupon_id IS NULL) = (coupon_code IS NULL)
        AND (coupon_id IS NOT NULL OR discount_total = 0)
      ) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE orders
      DROP CONSTRAINT IF EXISTS chk_orders_discount,
      DROP CONSTRAINT IF EXISTS fk_orders_coupon_id,
      DROP COLUMN IF EXISTS discount_total,
      DROP COLUMN IF EXISTS coupon_code,
      DROP COLUMN IF EXISTS coupon_id;
  `);
}
