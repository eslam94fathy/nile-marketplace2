import { type Knex } from 'knex';

// ordering: append-only audit of every derived order status change, written in the same
// transaction (spec 09 §1.1).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE order_status_history (
      id            UUID         NOT NULL DEFAULT uuidv7(),
      order_id      UUID         NOT NULL,
      -- null on the first row (created at checkout)
      from_status   VARCHAR(30)  NULL,
      to_status     VARCHAR(30)  NOT NULL,
      actor_role    VARCHAR(20)  NOT NULL,
      -- null = system, or an actor known only by a profile id (delivery events carry the agent id)
      actor_user_id UUID         NULL,
      reason        VARCHAR(500) NULL,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_order_status_history PRIMARY KEY (id),
      CONSTRAINT fk_order_status_history_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
      -- Audit pointer, never a lookup path: no index.
      CONSTRAINT fk_order_status_history_actor_user_id
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_order_status_history_from_status CHECK (from_status IS NULL OR from_status IN (
        'pending_payment', 'placed', 'in_progress', 'completed', 'partially_completed', 'cancelled'
      )),
      CONSTRAINT chk_order_status_history_to_status CHECK (to_status IN (
        'pending_payment', 'placed', 'in_progress', 'completed', 'partially_completed', 'cancelled'
      )),
      CONSTRAINT chk_order_status_history_actor_role
        CHECK (actor_role IN ('customer', 'seller', 'admin', 'delivery_agent', 'system')),
      CONSTRAINT chk_order_status_history_system_actor CHECK (actor_role <> 'system' OR actor_user_id IS NULL)
    );

    -- Order timeline (admin detail): WHERE order_id = ANY(?) ORDER BY created_at
    CREATE INDEX idx_order_status_history_order_id_created_at ON order_status_history (order_id, created_at);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS order_status_history`);
}
