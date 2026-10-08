import { type Knex } from 'knex';

// pg_trgm: typo-tolerant / partial-word product name search (architecture §9).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP EXTENSION IF EXISTS pg_trgm`);
}
