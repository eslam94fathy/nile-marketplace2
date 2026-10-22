import { type Knex } from 'knex';

// Refund job's stuck check (spec 10 §8.3 step 4, database v2.0 §14.12):
//   WHERE status = 'processing' AND updated_at < now() - interval '<PAYMENT_REFUND_STUCK_MINUTES>'
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_payment_refunds_processing`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_payment_refunds_processing
      ON payment_refunds (updated_at)
      WHERE status = 'processing'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_payment_refunds_processing`);
}
