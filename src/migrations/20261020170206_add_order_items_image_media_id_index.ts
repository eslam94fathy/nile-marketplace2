import { type Knex } from 'knex';

// DB-Q9 (database v2.0 §14): order_items is a live table, so the index is built CONCURRENTLY, which
// Postgres refuses inside a transaction (CLAUDE.md §6.1).
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // Media cleanup deletes media_objects rows; the FK RESTRICT check looks up
  //   order_items WHERE image_media_id = ? (it would otherwise scan the table). Partial: items
  //   without an image never match.
  // A failed concurrent build leaves an INVALID index behind: drop it so a re-run builds a valid one.
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_order_items_image_media_id`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY idx_order_items_image_media_id
      ON order_items (image_media_id)
      WHERE image_media_id IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS idx_order_items_image_media_id`);
}
