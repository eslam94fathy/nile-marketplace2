import { type Knex } from 'knex';

// GET /admin/payments/refunds over every status (spec 10 §8.4, database v2.0 §14.12):
//   WHERE status = ? ORDER BY created_at, id (keyset). The pending_manual queue keeps its R1 index.
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_payment_refunds_status_created_at_id`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_payment_refunds_status_created_at_id
      ON payment_refunds (status, created_at, id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_payment_refunds_status_created_at_id`);
}
