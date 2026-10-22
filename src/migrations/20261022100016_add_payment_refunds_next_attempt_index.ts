import { type Knex } from 'knex';

// Refund job (spec 10 UC-PA-6, database v2.0 §14.12): candidates oldest first,
//   WHERE status = 'pending_auto' AND next_attempt_at <= now() ORDER BY next_attempt_at, id LIMIT ?
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_payment_refunds_next_attempt_at_id`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_payment_refunds_next_attempt_at_id
      ON payment_refunds (next_attempt_at, id)
      WHERE status = 'pending_auto'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_payment_refunds_next_attempt_at_id`);
}
