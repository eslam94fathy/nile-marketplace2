import { type Knex } from 'knex';

// ordering: returned units per order line (spec 09 §8.7, database v2.0 §14.11). NOT NULL with a temporary
// default that is dropped at once, so existing rows hold 0 and new rows must pass it (DB-Q7). The CHECK
// is added NOT VALID and validated by the next migration (database §14.2). line_total stays on the
// units not cancelled: a return leaves the delivered amounts as booked.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE order_items ADD COLUMN returned_quantity INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE order_items ALTER COLUMN returned_quantity DROP DEFAULT;
    ALTER TABLE order_items
      ADD CONSTRAINT chk_order_items_quantities
        CHECK (returned_quantity >= 0 AND cancelled_quantity + returned_quantity <= quantity) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE order_items
      DROP CONSTRAINT IF EXISTS chk_order_items_quantities,
      DROP COLUMN IF EXISTS returned_quantity;
  `);
}
