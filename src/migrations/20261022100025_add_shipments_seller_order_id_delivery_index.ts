import { type Knex } from 'knex';

// One delivery per seller order (spec 11 §8.1, database v2.0 §14.12), now that return shipments share
// the seller order: replaces uq_shipments_seller_order_id (dropped by the next migration). Serves
//   INSERT … ON CONFLICT (seller_order_id) WHERE kind = 'delivery' DO NOTHING and
//   WHERE seller_order_id = ? AND kind = 'delivery', and the fk_shipments_seller_order_id lookup path.
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS uq_shipments_seller_order_id_delivery`);
  await knex.raw(`
    CREATE UNIQUE INDEX CONCURRENTLY uq_shipments_seller_order_id_delivery
      ON shipments (seller_order_id)
      WHERE kind = 'delivery'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS uq_shipments_seller_order_id_delivery`);
}
