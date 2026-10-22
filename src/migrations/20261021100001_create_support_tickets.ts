import { type Knex } from 'knex';

// support: tickets opened by a customer or a seller (spec 16 §1, database v2.0 §14.7, D-18). Tickets
// are kept indefinitely (SU-6), so every FK is RESTRICT.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE SEQUENCE support_ticket_number_seq AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;

    CREATE TABLE support_tickets (
      id                     UUID           NOT NULL DEFAULT uuidv7(),
      -- 'T-' || lpad(nextval('support_ticket_number_seq')::text, 9, '0'), set in the INSERT (SU-16).
      ticket_number          VARCHAR(20)    NOT NULL,
      opener_user_id         UUID           NOT NULL,
      opener_role            VARCHAR(10)    NOT NULL,
      category               VARCHAR(30)    NOT NULL,
      subject                VARCHAR(150)   NOT NULL,
      status                 VARCHAR(20)    NOT NULL,
      -- Optional order link. A seller's ticket stores the order of its seller order too (SU-10).
      order_id               UUID,
      seller_order_id        UUID,
      -- Null: nobody has taken the ticket yet.
      assigned_admin_user_id UUID,
      -- Latest message the opener can see (public and system messages; internal notes leave it).
      last_message_at        TIMESTAMPTZ(3) NOT NULL,
      last_user_message_at   TIMESTAMPTZ(3) NOT NULL,
      -- Null until the first public admin reply.
      last_admin_message_at  TIMESTAMPTZ(3),
      -- Start of the current wait for an admin; set only while open / awaiting_admin (SU-12).
      awaiting_admin_since   TIMESTAMPTZ(3),
      -- SLA flag of the current or last wait, cleared when a new wait starts (SU-11).
      sla_breached_at        TIMESTAMPTZ,
      -- Set while resolved and kept by a close; cleared on reopen (SU-12).
      resolved_at            TIMESTAMPTZ,
      closed_at              TIMESTAMPTZ,
      created_at             TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      updated_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),
      CONSTRAINT pk_support_tickets PRIMARY KEY (id),
      CONSTRAINT uq_support_tickets_ticket_number UNIQUE (ticket_number),
      CONSTRAINT fk_support_tickets_opener_user_id
        FOREIGN KEY (opener_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT fk_support_tickets_order_id
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
      CONSTRAINT fk_support_tickets_seller_order_id
        FOREIGN KEY (seller_order_id) REFERENCES seller_orders (id) ON DELETE RESTRICT,
      CONSTRAINT fk_support_tickets_assigned_admin_user_id
        FOREIGN KEY (assigned_admin_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_support_tickets_opener_role CHECK (opener_role IN ('customer', 'seller')),
      CONSTRAINT chk_support_tickets_category CHECK (category IN (
        'order', 'payment', 'delivery', 'return', 'account', 'seller_onboarding', 'other'
      )),
      CONSTRAINT chk_support_tickets_seller_onboarding
        CHECK (category <> 'seller_onboarding' OR opener_role = 'seller'),
      CONSTRAINT chk_support_tickets_status
        CHECK (status IN ('open', 'awaiting_admin', 'awaiting_user', 'resolved', 'closed')),
      CONSTRAINT chk_support_tickets_subject_length CHECK (char_length(subject) >= 3),
      CONSTRAINT chk_support_tickets_seller_order_needs_order
        CHECK (seller_order_id IS NULL OR order_id IS NOT NULL),
      CONSTRAINT chk_support_tickets_resolved_at CHECK (
        (status <> 'resolved' OR resolved_at IS NOT NULL)
        AND (status NOT IN ('open', 'awaiting_admin', 'awaiting_user') OR resolved_at IS NULL)
      ),
      CONSTRAINT chk_support_tickets_closed_at CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
      CONSTRAINT chk_support_tickets_awaiting_admin_since
        CHECK ((status IN ('open', 'awaiting_admin')) = (awaiting_admin_since IS NOT NULL))
    );

    -- GET /support/tickets: WHERE opener_user_id = ? ORDER BY last_message_at DESC, id DESC (keyset).
    -- Also the open-ticket count (UC-SU-1): WHERE opener_user_id = ? AND status NOT IN (...), few rows.
    CREATE INDEX idx_support_tickets_opener_user_id_last_message_at_id
      ON support_tickets (opener_user_id, last_message_at DESC, id DESC);

    -- GET /admin/support/tickets?status[in]=...: WHERE status = ANY(?) ORDER BY last_message_at DESC, id DESC.
    CREATE INDEX idx_support_tickets_status_last_message_at_id
      ON support_tickets (status, last_message_at DESC, id DESC);

    -- GET /admin/support/tickets without filters: ORDER BY last_message_at DESC, id DESC.
    CREATE INDEX idx_support_tickets_last_message_at_id
      ON support_tickets (last_message_at DESC, id DESC);

    -- Oldest-waiting queue (sort=awaitingAdminSince) and the SLA job:
    -- WHERE status IN ('open','awaiting_admin') [AND awaiting_admin_since < ?] ORDER BY awaiting_admin_since, id.
    CREATE INDEX idx_support_tickets_awaiting_admin_since_id
      ON support_tickets (awaiting_admin_since, id) WHERE status IN ('open', 'awaiting_admin');

    -- "My tickets": WHERE assigned_admin_user_id = ? ORDER BY last_message_at DESC, id DESC.
    CREATE INDEX idx_support_tickets_assigned_admin_user_id
      ON support_tickets (assigned_admin_user_id, last_message_at DESC, id DESC)
      WHERE assigned_admin_user_id IS NOT NULL;

    -- Auto-close job: WHERE status = 'resolved' AND resolved_at < ? ORDER BY resolved_at LIMIT ?.
    CREATE INDEX idx_support_tickets_resolved_at
      ON support_tickets (resolved_at) WHERE status = 'resolved';
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS support_tickets;
    DROP SEQUENCE IF EXISTS support_ticket_number_seq;
  `);
}
