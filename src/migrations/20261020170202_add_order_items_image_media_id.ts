import { type Knex } from 'knex';

// ordering: the variant's image at checkout (spec 09 §8.3, database v2.0 §14). Nullable: null means the
// variant had no image. order_items is large, so the FK is added NOT VALID (no long lock) and
// validated by the next migration (database §14.2); it is enforced for new rows and deletes already.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE order_items
      ADD COLUMN image_media_id UUID,
      ADD CONSTRAINT fk_order_items_image_media_id
        FOREIGN KEY (image_media_id) REFERENCES media_objects (id) ON DELETE RESTRICT NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE order_items
      DROP CONSTRAINT IF EXISTS fk_order_items_image_media_id,
      DROP COLUMN IF EXISTS image_media_id;
  `);
}
