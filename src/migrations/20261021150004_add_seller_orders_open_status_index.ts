import { type Knex } from 'knex';

// Dashboard (spec 20 §3.2, BO-13, BO-21, D-22): seller orders per open status,
//   SELECT status, count(*) FROM seller_orders WHERE status IN (<open statuses>) GROUP BY status.
// Partial: open seller orders are a small share of the table. The list mirrors OPEN_SELLER_ORDER_STATUSES.
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_seller_orders_open_status`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_seller_orders_open_status
      ON seller_orders (status)
      WHERE status IN (
        'pending_payment', 'placed', 'accepted', 'ready_for_pickup',
        'picked_up', 'out_for_delivery', 'delivery_failed', 'returning_to_seller'
      )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_seller_orders_open_status`);
}
