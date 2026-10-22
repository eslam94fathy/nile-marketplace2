import { type Knex } from 'knex';

// Spec 06 §9.3, database v2.0 §14.4: products is a live table, so the index is built CONCURRENTLY,
// which Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // Public listing by rating without a category filter: WHERE VIS ORDER BY COALESCE(rating_avg, 0)
  //   DESC, id DESC (unrated products last; keyset cursor on (COALESCE(rating_avg, 0), id)). Within a
  //   category the category index is used and the category's rows sorted (DB-Q10).
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_products_rating_id`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_products_rating_id
      ON products ((COALESCE(rating_avg, 0)) DESC, id DESC)
      WHERE status = 'active' AND seller_active AND deleted_at IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_products_rating_id`);
}
