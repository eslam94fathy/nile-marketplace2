import { type Knex } from 'knex';

// notifications: the in-app notification centre (spec 13 §8.1, database v2.0 §14.6). One row per
// event and recipient; texts carry no names, addresses or amounts (R-7).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE user_notifications (
      id              UUID           NOT NULL DEFAULT uuidv7(),
      user_id         UUID           NOT NULL,
      category        VARCHAR(20)    NOT NULL,
      type            VARCHAR(40)    NOT NULL,
      title           VARCHAR(120)   NOT NULL,
      body            VARCHAR(300)   NOT NULL,
      -- A client route such as /orders/<id>, never a full URL. Null: nothing to open.
      link            VARCHAR(300),
      source_event_id UUID           NOT NULL,
      -- Null until the user reads it.
      read_at         TIMESTAMPTZ,
      -- Null until a push went out (spec 13 UC-NO-3), or when none is sent.
      push_sent_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
      CONSTRAINT pk_user_notifications PRIMARY KEY (id),
      CONSTRAINT fk_user_notifications_user_id
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
      -- One row per event and recipient (UC-NO-2: ON CONFLICT DO NOTHING); also the user's rows.
      CONSTRAINT uq_user_notifications_user_id_source_event_id UNIQUE (user_id, source_event_id),
      CONSTRAINT chk_user_notifications_category
        CHECK (category IN ('orders', 'shipments', 'support', 'promotions')),
      -- Spec 13 §8.2, §8.8, §8.9: the later phases' types are listed now, so they need no CHECK change.
      CONSTRAINT chk_user_notifications_type CHECK (type IN (
        'order_placed', 'seller_order_received', 'seller_order_accepted', 'seller_order_cancelled',
        'payment_failed', 'shipment_assigned', 'out_for_delivery', 'delivery_attempt_failed', 'delivered',
        'support_reply', 'support_user_message', 'support_resolved',
        'review_received', 'review_replied', 'product_blocked',
        'return_requested', 'return_approved', 'return_rejected', 'return_picked_up', 'return_received',
        'return_completed', 'return_refused', 'refund_issued'
      )),
      CONSTRAINT chk_user_notifications_title CHECK (char_length(title) > 0),
      CONSTRAINT chk_user_notifications_body CHECK (char_length(body) > 0),
      CONSTRAINT chk_user_notifications_link CHECK (link IS NULL OR link LIKE '/%')
    );

    -- GET /me/notifications: WHERE user_id = ? [AND category ...] ORDER BY created_at DESC, id DESC
    -- (keyset on (created_at, id)).
    CREATE INDEX idx_user_notifications_user_id_created_at_id
      ON user_notifications (user_id, created_at DESC, id DESC);

    -- Unread count (SELECT 1 ... WHERE user_id = ? AND read_at IS NULL LIMIT 100) and the read=false
    -- list, keyset on (created_at, id) as above (D-16: id added for the keyset).
    CREATE INDEX idx_user_notifications_user_id_unread
      ON user_notifications (user_id, created_at DESC, id DESC) WHERE read_at IS NULL;

    -- Retention job (UC-NO-5): DELETE ... WHERE created_at < ? ORDER BY created_at, id LIMIT ?.
    CREATE INDEX idx_user_notifications_created_at ON user_notifications (created_at);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS user_notifications`);
}
