import { type Knex } from 'knex';

// Admin customer directory (spec 20 §3.3): name search
//   WHERE (first_name || ' ' || last_name) ILIKE '%mona a%' (pg_trgm, database §14.5).
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_customers_name_trgm`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_customers_name_trgm
      ON customers USING GIN ((first_name || ' ' || last_name) gin_trgm_ops)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_customers_name_trgm`);
}
