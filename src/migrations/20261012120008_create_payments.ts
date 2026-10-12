import { type Knex } from 'knex';

// payments: one payment per checkout (spec 10 §1, Q-9), COD or Kashier. The Kashier session is
// stored once per payment (spec 10 PA-3, D-8).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE payments (
      id                          UUID          NOT NULL DEFAULT uuidv7(),
      order_id                    UUID          NOT NULL,
      method                      VARCHAR(20)   NOT NULL,
      status                      VARCHAR(40)   NOT NULL,
      -- Order total at checkout; COD: adjusted on cancellations and set to the collected amount on close.
      amount                      NUMERIC(12,2) NOT NULL,
      -- COD: cash collected by agents. Kashier: amount paid.
      collected_amount            NUMERIC(12,2) NOT NULL,
      refunded_amount             NUMERIC(12,2) NOT NULL,
      -- Kashier session id, URL and expiry: null for COD and before a session exists.
      provider_order_ref          VARCHAR(100)  NULL,
      provider_session_url        VARCHAR(500)  NULL,
      provider_session_expires_at TIMESTAMPTZ   NULL,
      provider_transaction_ref    VARCHAR(100)  NULL,
      paid_at                     TIMESTAMPTZ   NULL,
      created_at                  TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_payments PRIMARY KEY (id),
      -- Cross-module FK (D12). One payment per checkout; also the order → payment lookup:
      -- WHERE order_id = ANY(?)
      CONSTRAINT fk_payments_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
      CONSTRAINT uq_payments_order_id UNIQUE (order_id),
      CONSTRAINT chk_payments_method CHECK (method IN ('cod', 'kashier')),
      CONSTRAINT chk_payments_status CHECK (
        (method = 'cod' AND status IN ('pending', 'partially_collected', 'collected', 'cancelled'))
        OR (method = 'kashier' AND status IN (
          'initiated', 'paid', 'failed', 'expired', 'partially_refunded_manually', 'refunded_manually'
        ))
      ),
      CONSTRAINT chk_payments_amount CHECK (amount >= 0),
      CONSTRAINT chk_payments_collected_amount CHECK (collected_amount >= 0),
      CONSTRAINT chk_payments_refunded_amount CHECK (refunded_amount >= 0 AND refunded_amount <= collected_amount),
      -- A session is stored as a whole, and only Kashier payments have one.
      CONSTRAINT chk_payments_session_columns CHECK (
        (provider_order_ref IS NULL AND provider_session_url IS NULL AND provider_session_expires_at IS NULL)
        OR (method = 'kashier' AND provider_order_ref IS NOT NULL AND provider_session_url IS NOT NULL
            AND provider_session_expires_at IS NOT NULL)
      )
    );

    -- Kashier session → payment (webhook fallback, support): WHERE provider_order_ref = ?
    CREATE UNIQUE INDEX uq_payments_provider_order_ref ON payments (provider_order_ref)
      WHERE provider_order_ref IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS payments`);
}
