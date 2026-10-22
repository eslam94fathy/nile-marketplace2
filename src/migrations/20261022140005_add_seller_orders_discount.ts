import { type Knex } from 'knex';

// ordering: a seller order's share of the coupon discount, kept on the units not cancelled like subtotal
// (spec 09 §8.8, OR-31, database v2.0 §14.11). The temporary default is dropped at once (DB-Q7); the CHECKs
// are NOT VALID and validated by the next migration (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE seller_orders
      ADD COLUMN discount_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN discount_funding VARCHAR(10);
    ALTER TABLE seller_orders ALTER COLUMN discount_amount DROP DEFAULT;
    ALTER TABLE seller_orders
      ADD CONSTRAINT chk_seller_orders_discount_funding
        CHECK (discount_funding IS NULL OR discount_funding IN ('platform', 'seller')) NOT VALID,
      ADD CONSTRAINT chk_seller_orders_discount CHECK (
        discount_amount >= 0 AND discount_amount <= subtotal
        AND (discount_funding IS NOT NULL) = (discount_amount > 0)
      ) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE seller_orders
      DROP CONSTRAINT IF EXISTS chk_seller_orders_discount,
      DROP CONSTRAINT IF EXISTS chk_seller_orders_discount_funding,
      DROP COLUMN IF EXISTS discount_funding,
      DROP COLUMN IF EXISTS discount_amount;
  `);
}
