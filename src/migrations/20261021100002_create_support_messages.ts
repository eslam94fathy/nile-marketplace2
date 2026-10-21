import { type Knex } from 'knex';

// support: the timeline of a ticket (spec 16 §1, database v2.0 §14.7, D-18). Append-only: public
// messages, admin internal notes and server-written system lines.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE support_messages (
      id             UUID           NOT NULL DEFAULT uuidv7(),
      ticket_id      UUID           NOT NULL,
      kind           VARCHAR(20)    NOT NULL,
      -- Null exactly for system lines (chk_support_messages_sender).
      sender_user_id UUID,
      sender_role    VARCHAR(10)    NOT NULL,
      body           VARCHAR(4000)  NOT NULL,
      created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      CONSTRAINT pk_support_messages PRIMARY KEY (id),
      CONSTRAINT fk_support_messages_ticket_id
        FOREIGN KEY (ticket_id) REFERENCES support_tickets (id) ON DELETE RESTRICT,
      CONSTRAINT fk_support_messages_sender_user_id
        FOREIGN KEY (sender_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_support_messages_kind CHECK (kind IN ('message', 'internal_note', 'system')),
      CONSTRAINT chk_support_messages_sender_role
        CHECK (sender_role IN ('customer', 'seller', 'admin', 'system')),
      CONSTRAINT chk_support_messages_sender CHECK (
        (kind = 'system') = (sender_user_id IS NULL) AND (kind = 'system') = (sender_role = 'system')
      ),
      CONSTRAINT chk_support_messages_internal_note_by_admin
        CHECK (kind <> 'internal_note' OR sender_role = 'admin'),
      CONSTRAINT chk_support_messages_body_length CHECK (char_length(body) >= 1)
    );

    -- Message list: WHERE ticket_id = ? [AND kind <> 'internal_note'] ORDER BY created_at DESC, id DESC
    -- (keyset on (created_at, id)).
    CREATE INDEX idx_support_messages_ticket_id_created_at_id
      ON support_messages (ticket_id, created_at DESC, id DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS support_messages;`);
}
