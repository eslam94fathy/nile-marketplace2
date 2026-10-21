import { type Knex } from 'knex';

// support: per-user read state of a ticket (spec 16 §1.2 unread, UC-SU-4). One row per (ticket, user).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE support_ticket_reads (
      ticket_id    UUID           NOT NULL,
      user_id      UUID           NOT NULL,
      -- Same precision as the last_*_message_at columns it is compared with: a now() rounded to
      -- milliseconds on one side only would leave the sender's own message unread.
      last_read_at TIMESTAMPTZ(3) NOT NULL,
      -- Read state of a page of tickets: WHERE ticket_id = ANY(?) AND user_id = ? (the PK).
      CONSTRAINT pk_support_ticket_reads PRIMARY KEY (ticket_id, user_id),
      CONSTRAINT fk_support_ticket_reads_ticket_id
        FOREIGN KEY (ticket_id) REFERENCES support_tickets (id) ON DELETE RESTRICT,
      CONSTRAINT fk_support_ticket_reads_user_id
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS support_ticket_reads;`);
}
