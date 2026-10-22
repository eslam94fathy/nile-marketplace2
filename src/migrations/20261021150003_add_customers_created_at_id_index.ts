import { type Knex } from 'knex';

// Admin customer directory (spec 20 §3.3, BO-19): ORDER BY created_at DESC, id DESC with a keyset cursor.
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_customers_created_at_id`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_customers_created_at_id
      ON customers (created_at DESC, id DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_customers_created_at_id`);
}
