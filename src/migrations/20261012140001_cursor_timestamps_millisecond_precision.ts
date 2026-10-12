import { type Knex } from 'knex';

// Every timestamp a list cursor sorts on keeps milliseconds, the precision of a JS Date and so of the
// cursor (CLAUDE.md §6.2, database D-11). With microseconds a cursor of `…:00.572` repeats the row
// `…:00.572456` on the next page of an ascending list and skips same-millisecond rows of a
// descending one. Postgres rounds the existing values. The ALTER rewrites each table and rebuilds
// its indexes: fine before the first release; on live data this would need an expand/contract.
const COLUMNS: readonly (readonly [table: string, column: string])[] = [
  ['users', 'created_at'],
  ['sellers', 'created_at'],
  ['products', 'created_at'],
  ['products', 'published_at'],
  ['inventory_movements', 'created_at'],
  ['orders', 'created_at'],
  ['seller_orders', 'created_at'],
  ['payment_refunds', 'created_at'],
  ['delivery_agents', 'created_at'],
  ['shipments', 'created_at'],
];

export async function up(knex: Knex): Promise<void> {
  for (const [table, column] of COLUMNS) {
    await knex.raw('ALTER TABLE ?? ALTER COLUMN ?? TYPE TIMESTAMPTZ(3)', [table, column]);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const [table, column] of COLUMNS) {
    await knex.raw('ALTER TABLE ?? ALTER COLUMN ?? TYPE TIMESTAMPTZ', [table, column]);
  }
}
