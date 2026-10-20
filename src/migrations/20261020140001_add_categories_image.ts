import { type Knex } from 'knex';

// catalog: one optional image per category (spec 06 §8.1, database v2.0 §14.4). Nullable columns
// on a table of hundreds of rows: no default, no rewrite.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE categories
      ADD COLUMN image_media_id UUID,
      ADD COLUMN image_alt_text VARCHAR(200),
      ADD CONSTRAINT fk_categories_image_media_id
        FOREIGN KEY (image_media_id) REFERENCES media_objects (id) ON DELETE RESTRICT,
      -- One category per image; also the index behind the media cleanup's RESTRICT check.
      ADD CONSTRAINT uq_categories_image_media_id UNIQUE (image_media_id),
      ADD CONSTRAINT chk_categories_image_alt_text
        CHECK (image_alt_text IS NULL OR image_media_id IS NOT NULL);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE categories
      DROP CONSTRAINT IF EXISTS chk_categories_image_alt_text,
      DROP CONSTRAINT IF EXISTS uq_categories_image_media_id,
      DROP CONSTRAINT IF EXISTS fk_categories_image_media_id,
      DROP COLUMN IF EXISTS image_alt_text,
      DROP COLUMN IF EXISTS image_media_id;
  `);
}
