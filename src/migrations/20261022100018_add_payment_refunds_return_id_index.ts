import { type Knex } from 'knex';

// getRefundsByReturnIds (spec 10 §8.5, database v2.0 §14.12): WHERE return_id = ANY(?). Also the
// fk_payment_refunds_return_id lookup path.
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_payment_refunds_return_id`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_payment_refunds_return_id
      ON payment_refunds (return_id)
      WHERE return_id IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_payment_refunds_return_id`);
}
