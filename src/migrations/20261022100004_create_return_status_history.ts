import { type Knex } from 'knex';

// returns: append-only audit of every return transition, written in the same transaction (spec 18 §1.1).
// Same shape as the order histories; also the source of the timeline (spec 18 §4).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE return_status_history (
      id            UUID         NOT NULL DEFAULT uuidv7(),
      return_id     UUID         NOT NULL,
      -- null on the first row (the request)
      from_status   VARCHAR(20),
      to_status     VARCHAR(20)  NOT NULL,
      actor_role    VARCHAR(20)  NOT NULL,
      -- null = system, or an actor known only by a profile id (delivery events carry the agent id)
      actor_user_id UUID,
      reason        VARCHAR(500),
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_return_status_history PRIMARY KEY (id),
      CONSTRAINT fk_return_status_history_return_id
        FOREIGN KEY (return_id) REFERENCES return_requests (id) ON DELETE RESTRICT,
      -- Audit pointer, never a lookup path: no index.
      CONSTRAINT fk_return_status_history_actor_user_id
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_return_status_history_from_status CHECK (from_status IS NULL OR from_status IN (
        'requested', 'rejected', 'escalated', 'approved', 'picked_up', 'received', 'disputed',
        'completed', 'refused', 'cancelled', 'pickup_failed'
      )),
      CONSTRAINT chk_return_status_history_to_status CHECK (to_status IN (
        'requested', 'rejected', 'escalated', 'approved', 'picked_up', 'received', 'disputed',
        'completed', 'refused', 'cancelled', 'pickup_failed'
      )),
      CONSTRAINT chk_return_status_history_actor_role
        CHECK (actor_role IN ('customer', 'seller', 'admin', 'delivery_agent', 'system')),
      CONSTRAINT chk_return_status_history_system_actor CHECK (actor_role <> 'system' OR actor_user_id IS NULL)
    );
    -- Timelines of a page of requests: WHERE return_id = ANY(?) ORDER BY created_at.
    CREATE INDEX idx_return_status_history_return_id_created_at
      ON return_status_history (return_id, created_at);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS return_status_history`);
}
