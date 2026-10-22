import { type Knex } from 'knex';

// sellers: the rating projection (spec 05 §8.1, database v2.0 §14.5). A table of a few thousand rows:
// the CHECKs are validated at once. The NOT NULL columns come with a constant default (no rewrite)
// that is dropped in the same migration, so seller creation passes the values (DB-Q7, G13).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE sellers
      ADD COLUMN rating_count   INTEGER      NOT NULL DEFAULT 0,
      -- Null: no published review of the seller's products yet.
      ADD COLUMN rating_avg     NUMERIC(3,2),
      ADD COLUMN rating_version BIGINT       NOT NULL DEFAULT 0;
    ALTER TABLE sellers
      ALTER COLUMN rating_count DROP DEFAULT,
      ALTER COLUMN rating_version DROP DEFAULT;
    ALTER TABLE sellers
      ADD CONSTRAINT chk_sellers_rating_count CHECK (rating_count >= 0),
      ADD CONSTRAINT chk_sellers_rating_avg
        CHECK ((rating_avg IS NULL) = (rating_count = 0) AND (rating_avg IS NULL OR rating_avg BETWEEN 1 AND 5)),
      ADD CONSTRAINT chk_sellers_rating_version CHECK (rating_version >= 0);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE sellers
      DROP CONSTRAINT IF EXISTS chk_sellers_rating_version,
      DROP CONSTRAINT IF EXISTS chk_sellers_rating_avg,
      DROP CONSTRAINT IF EXISTS chk_sellers_rating_count,
      DROP COLUMN IF EXISTS rating_version,
      DROP COLUMN IF EXISTS rating_avg,
      DROP COLUMN IF EXISTS rating_count;
  `);
}
