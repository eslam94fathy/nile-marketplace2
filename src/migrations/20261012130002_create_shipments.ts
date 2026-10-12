import { type Knex } from 'knex';

// delivery: one shipment per seller order, created from seller_order.ready_for_pickup with the
// snapshots the agent's screen and the fee rules need (spec 11 UC-DE-1, D-2). Delivery can't call
// ordering, so nothing here is read back from ordering's tables.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE shipments (
      id                        UUID          NOT NULL DEFAULT uuidv7(),
      seller_order_id           UUID          NOT NULL,
      order_id                  UUID          NOT NULL,
      agent_id                  UUID          NULL,
      status                    VARCHAR(30)   NOT NULL,
      order_number              VARCHAR(20)   NOT NULL,
      payment_method            VARCHAR(20)   NOT NULL,
      -- The checkout's COD fee, taken by the fee carrier (SD-2, DB-Q1); 0.00 for Kashier.
      order_delivery_fee        NUMERIC(12,2) NOT NULL,
      pickup_business_name      VARCHAR(150)  NOT NULL,
      pickup_governorate_id     UUID          NOT NULL,
      pickup_phone              VARCHAR(16)   NOT NULL,
      pickup_city               VARCHAR(100)  NOT NULL,
      pickup_area               VARCHAR(100)  NOT NULL,
      pickup_street             VARCHAR(200)  NOT NULL,
      pickup_building           VARCHAR(50)   NOT NULL,
      pickup_landmark           VARCHAR(200)  NULL,
      dropoff_recipient_name    VARCHAR(100)  NOT NULL,
      dropoff_recipient_phone   VARCHAR(16)   NOT NULL,
      dropoff_governorate_id    UUID          NOT NULL,
      dropoff_governorate_name  VARCHAR(100)  NOT NULL,
      dropoff_city              VARCHAR(100)  NOT NULL,
      dropoff_area              VARCHAR(100)  NOT NULL,
      dropoff_street            VARCHAR(200)  NOT NULL,
      dropoff_building          VARCHAR(50)   NOT NULL,
      dropoff_floor             VARCHAR(10)   NULL,
      dropoff_apartment         VARCHAR(10)   NULL,
      dropoff_landmark          VARCHAR(200)  NULL,
      -- COD: the seller order subtotal to collect. Kashier: 0.
      cod_items_amount          NUMERIC(12,2) NOT NULL,
      carries_delivery_fee      BOOLEAN       NOT NULL,
      cod_fee_amount            NUMERIC(12,2) NOT NULL,
      cod_collected_amount      NUMERIC(12,2) NULL,
      attempt_count             SMALLINT      NOT NULL,
      assigned_at               TIMESTAMPTZ   NULL,
      picked_up_at              TIMESTAMPTZ   NULL,
      delivered_at              TIMESTAMPTZ   NULL,
      returned_at               TIMESTAMPTZ   NULL,
      -- The seller order was cancelled after pickup: the agent confirms the return (spec 11 DE-6).
      seller_order_cancelled_at TIMESTAMPTZ   NULL,
      created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_shipments PRIMARY KEY (id),
      -- Idempotent creation from the event: INSERT … ON CONFLICT (seller_order_id) DO NOTHING.
      CONSTRAINT uq_shipments_seller_order_id UNIQUE (seller_order_id),
      -- Cross-module FKs (D12).
      CONSTRAINT fk_shipments_seller_order_id
        FOREIGN KEY (seller_order_id) REFERENCES seller_orders (id) ON DELETE RESTRICT,
      CONSTRAINT fk_shipments_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
      CONSTRAINT fk_shipments_agent_id FOREIGN KEY (agent_id) REFERENCES delivery_agents (id) ON DELETE RESTRICT,
      -- Governorates are never deleted and never a lookup path here: no index.
      CONSTRAINT fk_shipments_pickup_governorate_id
        FOREIGN KEY (pickup_governorate_id) REFERENCES governorates (id) ON DELETE RESTRICT,
      CONSTRAINT fk_shipments_dropoff_governorate_id
        FOREIGN KEY (dropoff_governorate_id) REFERENCES governorates (id) ON DELETE RESTRICT,
      CONSTRAINT chk_shipments_status CHECK (status IN (
        'unassigned', 'assigned', 'picked_up', 'out_for_delivery', 'delivery_failed',
        'returning_to_seller', 'returned_to_seller', 'delivered', 'cancelled'
      )),
      CONSTRAINT chk_shipments_payment_method CHECK (payment_method IN ('cod', 'kashier')),
      CONSTRAINT chk_shipments_amounts CHECK (
        order_delivery_fee >= 0 AND cod_items_amount >= 0 AND cod_fee_amount >= 0
        AND (cod_collected_amount IS NULL OR cod_collected_amount >= 0)
      ),
      CONSTRAINT chk_shipments_attempt_count CHECK (attempt_count BETWEEN 0 AND 3),
      CONSTRAINT chk_shipments_pickup_phone CHECK (pickup_phone ~ '^\\+[1-9][0-9]{6,14}$'),
      CONSTRAINT chk_shipments_dropoff_recipient_phone CHECK (dropoff_recipient_phone ~ '^\\+[1-9][0-9]{6,14}$'),
      -- The fee carrier holds the checkout's fee, every other shipment none (SD-2, DB-Q1).
      CONSTRAINT chk_shipments_fee_carrier CHECK (
        (carries_delivery_fee AND cod_fee_amount = order_delivery_fee)
        OR (NOT carries_delivery_fee AND cod_fee_amount = 0)
      ),
      -- Kashier shipments collect nothing at the door (spec 11 DE-8).
      CONSTRAINT chk_shipments_kashier_no_cash CHECK (
        payment_method = 'cod'
        OR (cod_items_amount = 0 AND order_delivery_fee = 0 AND NOT carries_delivery_fee
            AND cod_collected_amount IS NULL)
      ),
      -- unassigned ⇔ no agent; cancelled may or may not have had one; every other status has one.
      CONSTRAINT chk_shipments_agent CHECK (
        (status = 'unassigned' AND agent_id IS NULL)
        OR status = 'cancelled'
        OR (status NOT IN ('unassigned', 'cancelled') AND agent_id IS NOT NULL)
      ),
      CONSTRAINT chk_shipments_delivered CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
    );

    -- The agent's active shipments and the active-shipment count of assignment (UC-DE-1):
    -- WHERE agent_id = ? AND status IN (…active)
    CREATE INDEX idx_shipments_agent_id_status ON shipments (agent_id, status) WHERE agent_id IS NOT NULL;

    -- The agent's list, oldest first, over a long history too (D-10):
    -- WHERE agent_id = ? [AND status IN (…)] ORDER BY created_at, id
    CREATE INDEX idx_shipments_agent_id_created_at_id
      ON shipments (agent_id, created_at, id) WHERE agent_id IS NOT NULL;

    -- The assignment retry job, oldest first (D-10): WHERE status = 'unassigned' ORDER BY created_at, id
    CREATE INDEX idx_shipments_created_at_id ON shipments (created_at, id) WHERE status = 'unassigned';

    -- Admin list by status (D-3): WHERE status [= | IN] ? ORDER BY created_at DESC, id DESC
    CREATE INDEX idx_shipments_status_created_at_id ON shipments (status, created_at DESC, id DESC);

    -- Admin list without a status filter (D-10): ORDER BY created_at DESC, id DESC
    CREATE INDEX idx_shipments_created_at_desc_id ON shipments (created_at DESC, id DESC);

    -- Shipments of one checkout (fee carrier, admin filter): WHERE order_id = ?
    CREATE INDEX idx_shipments_order_id ON shipments (order_id);

    -- At most one fee-carrying shipment per checkout (SD-2, DB-Q1).
    CREATE UNIQUE INDEX uq_shipments_order_id_fee_carrier ON shipments (order_id) WHERE carries_delivery_fee;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS shipments`);
}
