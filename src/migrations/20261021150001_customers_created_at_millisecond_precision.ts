import { type Knex } from 'knex';

// `GET /admin/customers` pages on created_at (spec 20 §3.3, BO-18): it keeps milliseconds, the precision
// of the cursor (CLAUDE.md §6.2, database D-11, D-21). Postgres rounds the existing values. The ALTER
// rewrites the table and rebuilds its indexes: fine before the first release (P9 hasn't deployed
// anything); on live data this would need an expand/contract.
export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE customers ALTER COLUMN created_at TYPE TIMESTAMPTZ(3)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE customers ALTER COLUMN created_at TYPE TIMESTAMPTZ');
}
