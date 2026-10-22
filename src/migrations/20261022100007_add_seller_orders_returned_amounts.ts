import { type Knex } from 'knex';

// ordering: the sums of a delivered seller order's returns, next to its delivered amounts (spec 09 §8.7,
// database v2.0 §14.11). Temporary defaults dropped at once (DB-Q7); the CHECK is NOT VALID and validated
// by the next migration (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE seller_orders
      ADD COLUMN returned_subtotal   NUMERIC(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN returned_paid       NUMERIC(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN returned_commission NUMERIC(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN returned_seller_net NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE seller_orders
      ALTER COLUMN returned_subtotal DROP DEFAULT,
      ALTER COLUMN returned_paid DROP DEFAULT,
      ALTER COLUMN returned_commission DROP DEFAULT,
      ALTER COLUMN returned_seller_net DROP DEFAULT;
    ALTER TABLE seller_orders
      ADD CONSTRAINT chk_seller_orders_returned_amounts CHECK (
        returned_subtotal >= 0 AND returned_paid >= 0 AND returned_commission >= 0 AND returned_seller_net >= 0
        AND returned_subtotal <= subtotal
      ) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE seller_orders
      DROP CONSTRAINT IF EXISTS chk_seller_orders_returned_amounts,
      DROP COLUMN IF EXISTS returned_seller_net,
      DROP COLUMN IF EXISTS returned_commission,
      DROP COLUMN IF EXISTS returned_paid,
      DROP COLUMN IF EXISTS returned_subtotal;
  `);
}
