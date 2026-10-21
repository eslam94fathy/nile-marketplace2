import { type Knex } from 'knex';

// Dashboard (spec 20 §3.2, BO-12, D-20): orders placed today / in 7 days and the placed GMV per Cairo day:
//   WHERE o.placed_at >= ? AND o.placed_at < ?, joined to seller_orders by order_id.
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_orders_placed_at`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_orders_placed_at
      ON orders (placed_at)
      WHERE placed_at IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_orders_placed_at`);
}
