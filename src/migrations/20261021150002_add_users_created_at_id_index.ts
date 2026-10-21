import { type Knex } from 'knex';

// Admin user directory (spec 20 §3.3, BO-19): every role, ORDER BY created_at DESC, id DESC with a keyset
// cursor. idx_users_role_created_at serves only role-filtered pages.
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_users_created_at_id`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_users_created_at_id
      ON users (created_at DESC, id DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_users_created_at_id`);
}
