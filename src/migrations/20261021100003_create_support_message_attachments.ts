import { type Knex } from 'knex';

// support: up to 3 private images per message (spec 16 §1, R-9, database v2.0 §14.7). Claimed in
// media in the same transaction (spec 14 §2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE support_message_attachments (
      message_id UUID     NOT NULL,
      media_id   UUID     NOT NULL,
      position   SMALLINT NOT NULL,
      -- Attachments of a page of messages: WHERE message_id = ANY(?) ORDER BY message_id, position.
      CONSTRAINT pk_support_message_attachments PRIMARY KEY (message_id, position),
      CONSTRAINT fk_support_message_attachments_message_id
        FOREIGN KEY (message_id) REFERENCES support_messages (id) ON DELETE RESTRICT,
      CONSTRAINT fk_support_message_attachments_media_id
        FOREIGN KEY (media_id) REFERENCES media_objects (id) ON DELETE RESTRICT,
      -- One message per image; also the index behind the media cleanup's RESTRICT check.
      CONSTRAINT uq_support_message_attachments_media_id UNIQUE (media_id),
      CONSTRAINT chk_support_message_attachments_position CHECK (position BETWEEN 0 AND 2)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS support_message_attachments;`);
}
