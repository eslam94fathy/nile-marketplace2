import { type Knex } from 'knex';

// reviews: up to 4 public images per review (spec 17 RV-3, database v2.0 §14.8). Claimed in media in
// the same transaction; replaced as a whole on edit.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE review_images (
      review_id UUID     NOT NULL,
      media_id  UUID     NOT NULL,
      position  SMALLINT NOT NULL,
      -- Images of a page of reviews: WHERE review_id = ANY(?) ORDER BY review_id, position.
      CONSTRAINT pk_review_images PRIMARY KEY (review_id, position),
      CONSTRAINT fk_review_images_review_id
        FOREIGN KEY (review_id) REFERENCES product_reviews (id) ON DELETE RESTRICT,
      CONSTRAINT fk_review_images_media_id
        FOREIGN KEY (media_id) REFERENCES media_objects (id) ON DELETE RESTRICT,
      -- One review per image; also the index behind the media cleanup's RESTRICT check.
      CONSTRAINT uq_review_images_media_id UNIQUE (media_id),
      CONSTRAINT chk_review_images_position CHECK (position BETWEEN 0 AND 3)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS review_images;`);
}
