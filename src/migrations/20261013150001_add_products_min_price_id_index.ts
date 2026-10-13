import { type Knex } from 'knex';

// D-13 (02-database.md v1.13, found by the P8 load baseline): the public listing sorted by price
// without a category filter had no matching index and sorted every visible product. products is a
// live table, so the index is built CONCURRENTLY, which Postgres refuses inside a transaction
// (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // Listing without a category filter, by price: WHERE VIS [AND min_price BETWEEN ? AND ?]
  //   ORDER BY min_price, id (keyset cursor on (min_price, id)).
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_products_min_price_id`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_products_min_price_id
      ON products (min_price, id)
      WHERE status = 'active' AND seller_active AND deleted_at IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_products_min_price_id`);
}
