import { type Knex } from 'knex';

// ordering: one seller order per seller per checkout (spec 09 §1), with the seller's pickup and
// commission snapshot and its own status machine (§1.1). Transitions are conditional updates on the
// expected status.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE seller_orders (
      id                    UUID          NOT NULL DEFAULT uuidv7(),
      order_id              UUID          NOT NULL,
      seller_id             UUID          NOT NULL,
      status                VARCHAR(30)   NOT NULL,
      subtotal              NUMERIC(12,2) NOT NULL,
      commission_rate       NUMERIC(5,4)  NOT NULL,
      commission            NUMERIC(12,2) NOT NULL,
      seller_net            NUMERIC(12,2) NOT NULL,
      pickup_governorate_id UUID          NOT NULL,
      pickup_phone          VARCHAR(16)   NOT NULL,
      pickup_city           VARCHAR(100)  NOT NULL,
      pickup_area           VARCHAR(100)  NOT NULL,
      pickup_street         VARCHAR(200)  NOT NULL,
      pickup_building       VARCHAR(50)   NOT NULL,
      pickup_landmark       VARCHAR(200)  NULL,
      -- Set when the seller order becomes placed (+ SELLER_ACCEPT_TIMEOUT_HOURS).
      accept_deadline_at    TIMESTAMPTZ   NULL,
      cancel_reason         VARCHAR(40)   NULL,
      -- null = system (timeout, payment expiry / failure)
      cancelled_by_user_id  UUID          NULL,
      accepted_at           TIMESTAMPTZ   NULL,
      ready_at              TIMESTAMPTZ   NULL,
      picked_up_at          TIMESTAMPTZ   NULL,
      delivered_at          TIMESTAMPTZ   NULL,
      returned_at           TIMESTAMPTZ   NULL,
      cancelled_at          TIMESTAMPTZ   NULL,
      created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_seller_orders PRIMARY KEY (id),
      CONSTRAINT fk_seller_orders_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
      -- Cross-module FK (D12); served by the seller dashboard indexes.
      CONSTRAINT fk_seller_orders_seller_id FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE RESTRICT,
      -- Cross-module FK (D12). Never a lookup path, and governorates are never deleted: no index.
      CONSTRAINT fk_seller_orders_pickup_governorate_id
        FOREIGN KEY (pickup_governorate_id) REFERENCES governorates (id) ON DELETE RESTRICT,
      -- Audit pointer, never a lookup path: no index.
      CONSTRAINT fk_seller_orders_cancelled_by_user_id
        FOREIGN KEY (cancelled_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      -- One per seller per order; also the seller orders of an order: WHERE order_id = ANY(?)
      CONSTRAINT uq_seller_orders_order_id_seller_id UNIQUE (order_id, seller_id),
      CONSTRAINT chk_seller_orders_status CHECK (status IN (
        'pending_payment', 'placed', 'accepted', 'ready_for_pickup', 'picked_up', 'out_for_delivery',
        'delivery_failed', 'returning_to_seller', 'returned_to_seller', 'delivered', 'cancelled'
      )),
      CONSTRAINT chk_seller_orders_subtotal CHECK (subtotal >= 0),
      CONSTRAINT chk_seller_orders_commission_rate CHECK (commission_rate BETWEEN 0 AND 1),
      CONSTRAINT chk_seller_orders_commission CHECK (commission >= 0),
      CONSTRAINT chk_seller_orders_net CHECK (seller_net = subtotal - commission),
      CONSTRAINT chk_seller_orders_pickup_phone CHECK (pickup_phone ~ '^\\+[1-9][0-9]{6,14}$'),
      CONSTRAINT chk_seller_orders_cancel_reason CHECK (cancel_reason IS NULL OR cancel_reason IN (
        'customer_cancelled', 'seller_cancelled', 'seller_acceptance_timeout', 'payment_failed', 'payment_expired'
      )),
      -- cancelled is terminal: a cancelled seller order always has its reason and time, and only it does.
      CONSTRAINT chk_seller_orders_cancelled CHECK (
        (status = 'cancelled' AND cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL)
        OR (status <> 'cancelled' AND cancel_reason IS NULL AND cancelled_at IS NULL)
      )
    );

    -- Seller dashboard filtered by status, cursor-paginated:
    -- WHERE seller_id = ? AND status = ? ORDER BY created_at DESC, id DESC
    CREATE INDEX idx_seller_orders_seller_id_status_created_at_id
      ON seller_orders (seller_id, status, created_at DESC, id DESC);

    -- Seller dashboard without a status filter (pending_payment excluded by the query):
    -- WHERE seller_id = ? ORDER BY created_at DESC, id DESC
    CREATE INDEX idx_seller_orders_seller_id_created_at_id ON seller_orders (seller_id, created_at DESC, id DESC);

    -- Seller acceptance timeout job (spec 09 §3.10):
    -- WHERE status = 'placed' AND accept_deadline_at < now() ORDER BY accept_deadline_at LIMIT ?
    CREATE INDEX idx_seller_orders_accept_deadline_at ON seller_orders (accept_deadline_at) WHERE status = 'placed';
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS seller_orders`);
}
