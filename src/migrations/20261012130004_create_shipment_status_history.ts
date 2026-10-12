import { type Knex } from 'knex';

// delivery: append-only audit of every shipment transition, written in the same transaction
// (spec 11 §1.1). Same shape as the order histories.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE shipment_status_history (
      id            UUID         NOT NULL DEFAULT uuidv7(),
      shipment_id   UUID         NOT NULL,
      -- null on the first row (created from seller_order.ready_for_pickup)
      from_status   VARCHAR(30)  NULL,
      to_status     VARCHAR(30)  NOT NULL,
      actor_role    VARCHAR(20)  NOT NULL,
      -- null = system
      actor_user_id UUID         NULL,
      reason        VARCHAR(500) NULL,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_shipment_status_history PRIMARY KEY (id),
      CONSTRAINT fk_shipment_status_history_shipment_id
        FOREIGN KEY (shipment_id) REFERENCES shipments (id) ON DELETE RESTRICT,
      -- Audit pointer, never a lookup path: no index.
      CONSTRAINT fk_shipment_status_history_actor_user_id
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_shipment_status_history_from_status CHECK (from_status IS NULL OR from_status IN (
        'unassigned', 'assigned', 'picked_up', 'out_for_delivery', 'delivery_failed',
        'returning_to_seller', 'returned_to_seller', 'delivered', 'cancelled'
      )),
      CONSTRAINT chk_shipment_status_history_to_status CHECK (to_status IN (
        'unassigned', 'assigned', 'picked_up', 'out_for_delivery', 'delivery_failed',
        'returning_to_seller', 'returned_to_seller', 'delivered', 'cancelled'
      )),
      CONSTRAINT chk_shipment_status_history_actor_role
        CHECK (actor_role IN ('customer', 'seller', 'admin', 'delivery_agent', 'system')),
      CONSTRAINT chk_shipment_status_history_system_actor CHECK (actor_role <> 'system' OR actor_user_id IS NULL)
    );

    -- The shipment's history (admin detail): WHERE shipment_id = ANY(?) ORDER BY created_at
    CREATE INDEX idx_shipment_status_history_shipment_id_created_at
      ON shipment_status_history (shipment_id, created_at);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS shipment_status_history`);
}
