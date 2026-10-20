import { type Knex } from 'knex';

// catalog: up to 8 ordered images per product, optionally tied to one variant (spec 06 §8.1, R-2,
// database v2.0 §14.4). The limit is counted under the product lock, not a CHECK.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE product_images (
      id         UUID        NOT NULL DEFAULT uuidv7(),
      product_id UUID        NOT NULL,
      media_id   UUID        NOT NULL,
      -- null = the image belongs to the product as a whole.
      variant_id UUID,
      position   SMALLINT    NOT NULL,
      alt_text   VARCHAR(200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_product_images PRIMARY KEY (id),
      CONSTRAINT fk_product_images_product_id
        FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
      CONSTRAINT fk_product_images_media_id
        FOREIGN KEY (media_id) REFERENCES media_objects (id) ON DELETE RESTRICT,
      CONSTRAINT fk_product_images_variant_id
        FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE RESTRICT,
      -- One product per image; also the index behind the media cleanup's RESTRICT check.
      CONSTRAINT uq_product_images_media_id UNIQUE (media_id),
      -- One image per position. Deferrable, so a shift or a reorder in one statement is checked at
      -- its end. Also serves "images of a product" and the primary image of a page of products:
      -- WHERE product_id = ANY(?) ... ORDER BY product_id, position.
      CONSTRAINT uq_product_images_product_id_position
        UNIQUE (product_id, position) DEFERRABLE INITIALLY IMMEDIATE,
      CONSTRAINT chk_product_images_position CHECK (position BETWEEN 0 AND 7)
    );

    -- Untie the images of a soft-deleted variant: UPDATE ... WHERE variant_id = ?.
    CREATE INDEX idx_product_images_variant_id ON product_images (variant_id) WHERE variant_id IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS product_images;`);
}
