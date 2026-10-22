import { type Knex } from 'knex';

// One shipment per return (spec 11 UC-DE-8, database v2.0 §14.12): the idempotent creation
//   INSERT … ON CONFLICT (return_id) DO NOTHING, the return's shipment WHERE return_id = ?, and the
// fk_shipments_return_id lookup path. Deliveries have no return_id (NULLs never conflict).
// A live table: built CONCURRENTLY, which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS uq_shipments_return_id`);
  await knex.raw(`
    CREATE UNIQUE INDEX CONCURRENTLY uq_shipments_return_id ON shipments (return_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS uq_shipments_return_id`);
}
