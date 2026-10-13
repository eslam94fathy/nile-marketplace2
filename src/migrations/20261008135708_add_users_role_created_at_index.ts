import { type Knex } from 'knex';

// DB-Q6 (02-database.md v1.4): users is a live, growing table, so the index is built CONCURRENTLY,
// which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // Admin list (spec 03 §4.11): WHERE role = 'admin' [AND status IN (...)] [AND created_at >= / <= ?]
  //   ORDER BY created_at DESC, id DESC LIMIT n, keyset cursor on (created_at, id).
  // Equality column first, then the sort columns; serves the other roles' lists too.
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one
  // (IF NOT EXISTS would silently keep the broken index).
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_users_role_created_at`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_users_role_created_at
      ON users (role, created_at DESC, id DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_users_role_created_at`);
}
