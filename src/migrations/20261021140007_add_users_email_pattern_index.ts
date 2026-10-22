import { type Knex } from 'knex';

// Admin user directory (spec 20 §3.3): email prefix search WHERE email LIKE 'abc%'. uq_users_email uses the
// default collation, which can't serve LIKE; text_pattern_ops can (database §14.5).
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_users_email_pattern`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_users_email_pattern
      ON users (email text_pattern_ops)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_users_email_pattern`);
}
