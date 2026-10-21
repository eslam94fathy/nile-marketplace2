import { type Knex } from 'knex';

// Dashboard (spec 20 §3.2, database §14.11): delivered GMV per Cairo day and the top sellers over 30 days:
//   WHERE delivered_at >= ? (sum subtotal, group by day / seller_id), index-only with the INCLUDE columns.
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_seller_orders_delivered_at`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_seller_orders_delivered_at
      ON seller_orders (delivered_at) INCLUDE (subtotal, seller_id)
      WHERE delivered_at IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_seller_orders_delivered_at`);
}
