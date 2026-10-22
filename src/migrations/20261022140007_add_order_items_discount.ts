import { type Knex } from 'knex';

// ordering: a line's coupon share at checkout and the share its kept units still carry (spec 09 §8.7,
// §8.8, database v2.0 §14.11). Temporary defaults dropped at once (DB-Q7); the CHECK is NOT VALID and
// validated by the next migration (database §14.2). line_total is on the units not cancelled, so the kept
// share never exceeds it.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE order_items
      ADD COLUMN discount_original NUMERIC(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN discount_amount   NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE order_items
      ALTER COLUMN discount_original DROP DEFAULT,
      ALTER COLUMN discount_amount DROP DEFAULT;
    ALTER TABLE order_items
      ADD CONSTRAINT chk_order_items_discount CHECK (
        discount_original >= 0 AND discount_original <= unit_price * quantity
        AND discount_amount >= 0 AND discount_amount <= discount_original AND discount_amount <= line_total
      ) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE order_items
      DROP CONSTRAINT IF EXISTS chk_order_items_discount,
      DROP COLUMN IF EXISTS discount_amount,
      DROP COLUMN IF EXISTS discount_original;
  `);
}
