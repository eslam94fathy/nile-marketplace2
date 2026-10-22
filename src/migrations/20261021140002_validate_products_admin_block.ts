import { type Knex } from 'knex';

// Second step of the NOT VALID CHECK on products (database §14.2): VALIDATE takes only a SHARE UPDATE
// EXCLUSIVE lock, so reads and writes go on while existing rows are checked.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE products VALIDATE CONSTRAINT chk_products_admin_block`);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down drops it.
export async function down(): Promise<void> {}
