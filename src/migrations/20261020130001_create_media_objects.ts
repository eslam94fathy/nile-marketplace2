import { type Knex } from 'knex';

// media: uploaded images (spec 14 §1, database v2.0 §14.3). Storage keys derive from id and purpose.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE media_objects (
      id                    UUID           NOT NULL DEFAULT uuidv7(),
      owner_user_id         UUID           NOT NULL,
      purpose               VARCHAR(30)    NOT NULL,
      status                VARCHAR(20)    NOT NULL,
      -- Set only when failed (chk_media_objects_failure_reason).
      failure_reason        VARCHAR(30),
      declared_content_type VARCHAR(20)    NOT NULL,
      declared_size_bytes   INTEGER        NOT NULL,
      -- Of the processed large image, set once ready (chk_media_objects_ready).
      width                 SMALLINT,
      height                SMALLINT,
      processed_at          TIMESTAMPTZ,
      -- Lifecycle of the owning module's reference (spec 14 §2, UC-ME-4).
      claimed_at            TIMESTAMPTZ,
      released_at           TIMESTAMPTZ,
      retained_at           TIMESTAMPTZ,
      created_at            TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),
      CONSTRAINT pk_media_objects PRIMARY KEY (id),
      CONSTRAINT fk_media_objects_owner_user_id
        FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_media_objects_purpose CHECK (purpose IN (
        'product_image', 'category_image', 'support_attachment', 'review_image', 'return_photo'
      )),
      CONSTRAINT chk_media_objects_status CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
      CONSTRAINT chk_media_objects_failure_reason CHECK (
        (status = 'failed') = (failure_reason IS NOT NULL)
        AND (failure_reason IS NULL
          OR failure_reason IN ('decode_failed', 'unsupported_type', 'dimensions_out_of_range'))
      ),
      CONSTRAINT chk_media_objects_declared_content_type
        CHECK (declared_content_type IN ('image/jpeg', 'image/png', 'image/webp')),
      CONSTRAINT chk_media_objects_declared_size_bytes CHECK (declared_size_bytes > 0),
      CONSTRAINT chk_media_objects_ready CHECK (
        (status = 'ready') = (width IS NOT NULL AND height IS NOT NULL AND processed_at IS NOT NULL)
        AND (width IS NULL) = (height IS NULL)
        AND (width IS NULL OR (width > 0 AND height > 0))
      ),
      -- Only a ready image is attached; released only after a claim; retained only after a release.
      CONSTRAINT chk_media_objects_claimed CHECK (claimed_at IS NULL OR status = 'ready'),
      CONSTRAINT chk_media_objects_released CHECK (released_at IS NULL OR claimed_at IS NOT NULL),
      CONSTRAINT chk_media_objects_retained CHECK (retained_at IS NULL OR released_at IS NOT NULL)
    );

    -- Open uploads of a user (UC-ME-1): SELECT count(*) WHERE owner_user_id = ? AND status IN (...).
    CREATE INDEX idx_media_objects_owner_user_id_open ON media_objects (owner_user_id)
      WHERE status IN ('pending', 'processing');

    -- Cleanup of pending / unclaimed ready / failed rows (UC-ME-4):
    -- WHERE claimed_at IS NULL AND status <> 'processing' AND created_at < ? ORDER BY created_at, id.
    CREATE INDEX idx_media_objects_cleanup ON media_objects (created_at, id)
      WHERE claimed_at IS NULL AND status <> 'processing';

    -- Released rows (UC-ME-4): WHERE released_at IS NOT NULL AND retained_at IS NULL ORDER BY released_at, id.
    CREATE INDEX idx_media_objects_released ON media_objects (released_at, id)
      WHERE released_at IS NOT NULL AND retained_at IS NULL;

    -- Stuck processing (UC-ME-4): WHERE status = 'processing' AND updated_at < ?.
    CREATE INDEX idx_media_objects_processing ON media_objects (updated_at) WHERE status = 'processing';
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS media_objects;`);
}
