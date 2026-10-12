import { type Knex } from 'knex';

// ordering: one order per checkout (spec 09 §1). Holds the shipping snapshot, the checkout-level
// money (items total, delivery fee, agent fee-share rate) and the derived, stored status (§1.1).
// Every write that touches a checkout locks this row first (spec 09 §1.2, OR-3).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    -- Human-readable order numbers 'NM-' || lpad(nextval(...), 9, '0') (SD-10), set by the app in the INSERT.
    CREATE SEQUENCE order_number_seq AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;

    CREATE TABLE orders (
      id                    UUID          NOT NULL DEFAULT uuidv7(),
      order_number          VARCHAR(20)   NOT NULL,
      customer_id           UUID          NOT NULL,
      status                VARCHAR(30)   NOT NULL,
      payment_method        VARCHAR(20)   NOT NULL,
      items_total           NUMERIC(12,2) NOT NULL,
      delivery_fee          NUMERIC(12,2) NOT NULL,
      agent_fee_share_rate  NUMERIC(5,4)  NOT NULL,
      total                 NUMERIC(12,2) NOT NULL,
      ship_governorate_id   UUID          NOT NULL,
      ship_governorate_name VARCHAR(100)  NOT NULL,
      ship_recipient_name   VARCHAR(100)  NOT NULL,
      ship_recipient_phone  VARCHAR(16)   NOT NULL,
      ship_city             VARCHAR(100)  NOT NULL,
      ship_area             VARCHAR(100)  NOT NULL,
      ship_street           VARCHAR(200)  NOT NULL,
      ship_building         VARCHAR(50)   NOT NULL,
      ship_floor            VARCHAR(10)   NULL,
      ship_apartment        VARCHAR(10)   NULL,
      ship_landmark         VARCHAR(200)  NULL,
      -- Kashier only: checkout + KASHIER_PAYMENT_TTL_MINUTES.
      payment_expires_at    TIMESTAMPTZ   NULL,
      placed_at             TIMESTAMPTZ   NULL,
      completed_at          TIMESTAMPTZ   NULL,
      cancelled_at          TIMESTAMPTZ   NULL,
      created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_orders PRIMARY KEY (id),
      -- Support / agent lookup by number: WHERE order_number = ?
      CONSTRAINT uq_orders_order_number UNIQUE (order_number),
      -- Cross-module FK (D12); served by idx_orders_customer_id_created_at_id.
      CONSTRAINT fk_orders_customer_id FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
      -- Cross-module FK (D12). Never a lookup path, and governorates are never deleted: no index.
      CONSTRAINT fk_orders_ship_governorate_id
        FOREIGN KEY (ship_governorate_id) REFERENCES governorates (id) ON DELETE RESTRICT,
      CONSTRAINT chk_orders_order_number CHECK (order_number ~ '^NM-[0-9]{9,}$'),
      CONSTRAINT chk_orders_status
        CHECK (status IN ('pending_payment', 'placed', 'in_progress', 'completed', 'partially_completed', 'cancelled')),
      CONSTRAINT chk_orders_payment_method CHECK (payment_method IN ('cod', 'kashier')),
      CONSTRAINT chk_orders_items_total CHECK (items_total >= 0),
      CONSTRAINT chk_orders_delivery_fee CHECK (delivery_fee >= 0),
      CONSTRAINT chk_orders_agent_fee_share_rate CHECK (agent_fee_share_rate BETWEEN 0 AND 1),
      CONSTRAINT chk_orders_total CHECK (total = items_total + delivery_fee),
      CONSTRAINT chk_orders_ship_recipient_phone CHECK (ship_recipient_phone ~ '^\\+[1-9][0-9]{6,14}$'),
      -- Only Kashier orders have a payment window, and every Kashier order has one.
      CONSTRAINT chk_orders_payment_expires_at
        CHECK ((payment_method = 'kashier') = (payment_expires_at IS NOT NULL))
    );

    -- My orders, cursor-paginated: WHERE customer_id = ? [AND status ...] ORDER BY created_at DESC, id DESC
    CREATE INDEX idx_orders_customer_id_created_at_id ON orders (customer_id, created_at DESC, id DESC);

    -- Kashier payment expiry job (spec 09 §3.10):
    -- WHERE status = 'pending_payment' AND payment_expires_at < now() ORDER BY payment_expires_at LIMIT ?
    CREATE INDEX idx_orders_payment_expires_at ON orders (payment_expires_at) WHERE status = 'pending_payment';

    -- Admin order list by status: WHERE status = ? ORDER BY created_at DESC, id DESC
    CREATE INDEX idx_orders_status_created_at_id ON orders (status, created_at DESC, id DESC);

    -- Admin order list without a status filter: ORDER BY created_at DESC, id DESC (D-8)
    CREATE INDEX idx_orders_created_at_id ON orders (created_at DESC, id DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS orders;
    DROP SEQUENCE IF EXISTS order_number_seq;
  `);
}
