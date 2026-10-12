import { type Knex } from 'knex';

// payments: refunds due (R1: done by hand in the Kashier dashboard, then recorded by an admin,
// spec 10 UC-PA-4).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE payment_refunds (
      id                  UUID          NOT NULL DEFAULT uuidv7(),
      payment_id          UUID          NOT NULL,
      -- null = whole order or delivery fee
      seller_order_id     UUID          NULL,
      amount              NUMERIC(12,2) NOT NULL,
      reason              VARCHAR(40)   NOT NULL,
      status              VARCHAR(20)   NOT NULL,
      recorded_by_user_id UUID          NULL,
      recorded_at         TIMESTAMPTZ   NULL,
      provider_refund_ref VARCHAR(100)  NULL,
      created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_payment_refunds PRIMARY KEY (id),
      CONSTRAINT fk_payment_refunds_payment_id FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE RESTRICT,
      -- Cross-module FK (D12). No index: nothing looks refunds up by seller order (D-8).
      CONSTRAINT fk_payment_refunds_seller_order_id
        FOREIGN KEY (seller_order_id) REFERENCES seller_orders (id) ON DELETE RESTRICT,
      -- Audit pointer, never a lookup path: no index.
      CONSTRAINT fk_payment_refunds_recorded_by_user_id
        FOREIGN KEY (recorded_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_payment_refunds_amount CHECK (amount > 0),
      CONSTRAINT chk_payment_refunds_reason CHECK (reason IN (
        'seller_order_cancelled', 'items_cancelled', 'delivery_failed', 'late_payment_after_expiry',
        'all_cancelled_fee', 'amount_mismatch'
      )),
      CONSTRAINT chk_payment_refunds_status CHECK (status IN ('pending_manual', 'recorded')),
      -- A recorded refund always says who recorded it, when, and Kashier's reference; a pending one doesn't.
      CONSTRAINT chk_payment_refunds_recorded CHECK (
        (status = 'recorded' AND recorded_by_user_id IS NOT NULL AND recorded_at IS NOT NULL
          AND provider_refund_ref IS NOT NULL)
        OR (status = 'pending_manual' AND recorded_by_user_id IS NULL AND recorded_at IS NULL
          AND provider_refund_ref IS NULL)
      )
    );

    -- Admin refund queue, oldest first, cursor-paginated (D-8):
    -- WHERE status = 'pending_manual' ORDER BY created_at, id
    CREATE INDEX idx_payment_refunds_created_at_id ON payment_refunds (created_at, id)
      WHERE status = 'pending_manual';

    -- Refunds of a payment (admin payment view): WHERE payment_id = ?
    CREATE INDEX idx_payment_refunds_payment_id ON payment_refunds (payment_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS payment_refunds`);
}
