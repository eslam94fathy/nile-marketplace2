import { type Knex } from 'knex';

// Second step of the NOT VALID CHECKs on products (database §14.2): VALIDATE takes only a SHARE UPDATE
// EXCLUSIVE lock, so reads and writes go on while existing rows are checked.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE products VALIDATE CONSTRAINT chk_products_rating_count;
    ALTER TABLE products VALIDATE CONSTRAINT chk_products_rating_avg;
    ALTER TABLE products VALIDATE CONSTRAINT chk_products_rating_version;
  `);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down drops them.
export async function down(): Promise<void> {}
