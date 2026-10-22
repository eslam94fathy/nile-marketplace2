import { type Knex } from 'knex';

// catalog: the rating projection on products (spec 06 §9.1, database v2.0 §14.4). products is a live
// table: the NOT NULL columns come with a constant default (metadata only, no rewrite) that is dropped
// in the same migration, so the app must pass the values from now on (DB-Q7, G13). The CHECKs are added
// NOT VALID and validated by the next migration (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE products
      ADD COLUMN rating_count   INTEGER      NOT NULL DEFAULT 0,
      -- Null: no published review yet (the stated reason for a nullable column, spec 06 §9.1).
      ADD COLUMN rating_avg     NUMERIC(3,2),
      ADD COLUMN rating_version BIGINT       NOT NULL DEFAULT 0;
    ALTER TABLE products
      ALTER COLUMN rating_count DROP DEFAULT,
      ALTER COLUMN rating_version DROP DEFAULT;
    ALTER TABLE products
      ADD CONSTRAINT chk_products_rating_count CHECK (rating_count >= 0) NOT VALID,
      ADD CONSTRAINT chk_products_rating_avg
        CHECK ((rating_avg IS NULL) = (rating_count = 0) AND (rating_avg IS NULL OR rating_avg BETWEEN 1 AND 5))
        NOT VALID,
      ADD CONSTRAINT chk_products_rating_version CHECK (rating_version >= 0) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE products
      DROP CONSTRAINT IF EXISTS chk_products_rating_version,
      DROP CONSTRAINT IF EXISTS chk_products_rating_avg,
      DROP CONSTRAINT IF EXISTS chk_products_rating_count,
      DROP COLUMN IF EXISTS rating_version,
      DROP COLUMN IF EXISTS rating_avg,
      DROP COLUMN IF EXISTS rating_count;
  `);
}
