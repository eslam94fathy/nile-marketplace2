import { type Knex } from 'knex';

// returns: private photos of a request, up to 4 from the customer and 4 from the seller's dispute (spec 18
// §4, RE-2, RE-14). Claimed in media in the same transaction (spec 14 §2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE return_photos (
      return_id   UUID        NOT NULL,
      media_id    UUID        NOT NULL,
      uploaded_by VARCHAR(10) NOT NULL,
      position    SMALLINT    NOT NULL,
      -- Photos of a page of requests: WHERE return_id = ANY(?) ORDER BY return_id, uploaded_by, position.
      CONSTRAINT pk_return_photos PRIMARY KEY (return_id, uploaded_by, position),
      CONSTRAINT fk_return_photos_return_id
        FOREIGN KEY (return_id) REFERENCES return_requests (id) ON DELETE RESTRICT,
      CONSTRAINT fk_return_photos_media_id FOREIGN KEY (media_id) REFERENCES media_objects (id) ON DELETE RESTRICT,
      -- One request per photo; also the index behind the media cleanup's RESTRICT check.
      CONSTRAINT uq_return_photos_media_id UNIQUE (media_id),
      CONSTRAINT chk_return_photos_uploaded_by CHECK (uploaded_by IN ('customer', 'seller')),
      CONSTRAINT chk_return_photos_position CHECK (position BETWEEN 0 AND 3)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS return_photos`);
}
