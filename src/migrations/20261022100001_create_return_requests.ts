import { type Knex } from 'knex';

// returns: one row per return request (spec 18 §1, database v2.0 §14.9, D-24). The deadlines drive the
// three jobs; every transition is a conditional update on the expected status (spec 18 §1.1).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE SEQUENCE return_number_seq AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;

    CREATE TABLE return_requests (
      id                          UUID           NOT NULL DEFAULT uuidv7(),
      -- 'R-' || lpad(nextval('return_number_seq')::text, 9, '0'), set in the INSERT (RE-21).
      return_number               VARCHAR(20)    NOT NULL,
      seller_order_id             UUID           NOT NULL,
      order_id                    UUID           NOT NULL,
      customer_id                 UUID           NOT NULL,
      seller_id                   UUID           NOT NULL,
      status                      VARCHAR(20)    NOT NULL,
      reason                      VARCHAR(30)    NOT NULL,
      description                 VARCHAR(1000),
      -- Snapshot of the governorate fee and the agent share rate at request time (RE-5).
      return_fee                  NUMERIC(12,2)  NOT NULL,
      return_fee_payer            VARCHAR(10)    NOT NULL,
      agent_share_rate            NUMERIC(5,4)   NOT NULL,
      -- Estimated until completed, then final.
      refund_amount               NUMERIC(12,2)  NOT NULL,
      -- COD only: where the refund goes (RE-8). The details are AES-256-GCM ciphertext (S-1 key),
      -- cleared when the request ends; the method stays for the admin view.
      refund_payout_method        VARCHAR(20),
      refund_payout_encrypted     TEXT,
      -- The agent who picked the parcel up (from return_shipment.picked_up).
      agent_id                    UUID,
      rejection_reason            VARCHAR(500),
      refusal_reason              VARCHAR(20),
      escalation_note             VARCHAR(500),
      dispute_reason              VARCHAR(500),
      seller_decision_deadline_at TIMESTAMPTZ,
      escalation_deadline_at      TIMESTAMPTZ,
      inspection_deadline_at      TIMESTAMPTZ,
      approved_at                 TIMESTAMPTZ,
      received_at                 TIMESTAMPTZ,
      completed_at                TIMESTAMPTZ,
      -- Cursor-sorted by the customer, seller and admin lists (D-11).
      created_at                  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      updated_at                  TIMESTAMPTZ    NOT NULL DEFAULT now(),
      CONSTRAINT pk_return_requests PRIMARY KEY (id),
      CONSTRAINT uq_return_requests_return_number UNIQUE (return_number),
      -- Cross-module FKs (D12). seller_orders, orders, customers, sellers and agents are never deleted, so
      -- the RESTRICT checks never run; order_id and agent_id are never a lookup path: no index.
      CONSTRAINT fk_return_requests_seller_order_id
        FOREIGN KEY (seller_order_id) REFERENCES seller_orders (id) ON DELETE RESTRICT,
      CONSTRAINT fk_return_requests_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
      CONSTRAINT fk_return_requests_customer_id
        FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
      CONSTRAINT fk_return_requests_seller_id FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE RESTRICT,
      CONSTRAINT fk_return_requests_agent_id
        FOREIGN KEY (agent_id) REFERENCES delivery_agents (id) ON DELETE RESTRICT,
      CONSTRAINT chk_return_requests_return_number CHECK (return_number ~ '^R-[0-9]{9,}$'),
      CONSTRAINT chk_return_requests_status CHECK (status IN (
        'requested', 'rejected', 'escalated', 'approved', 'picked_up', 'received', 'disputed',
        'completed', 'refused', 'cancelled', 'pickup_failed'
      )),
      CONSTRAINT chk_return_requests_reason
        CHECK (reason IN ('damaged', 'wrong_item', 'not_as_described', 'changed_mind')),
      CONSTRAINT chk_return_requests_description CHECK (description IS NULL OR char_length(description) >= 1),
      CONSTRAINT chk_return_requests_return_fee CHECK (return_fee >= 0),
      CONSTRAINT chk_return_requests_return_fee_payer CHECK (return_fee_payer IN ('seller', 'customer')),
      -- Seller-fault reasons: the seller pays the fee; changed_mind: the customer's refund carries it (R-13).
      CONSTRAINT chk_return_requests_fee_payer_by_reason
        CHECK ((reason = 'changed_mind') = (return_fee_payer = 'customer')),
      CONSTRAINT chk_return_requests_agent_share_rate CHECK (agent_share_rate BETWEEN 0 AND 1),
      CONSTRAINT chk_return_requests_refund_amount CHECK (refund_amount >= 0),
      CONSTRAINT chk_return_requests_refund_payout_method
        CHECK (refund_payout_method IS NULL OR refund_payout_method IN ('mobile_wallet', 'instapay')),
      -- Details only with a method; the ciphertext is cleared at the end while the method stays.
      CONSTRAINT chk_return_requests_refund_payout CHECK (
        (refund_payout_encrypted IS NULL OR refund_payout_method IS NOT NULL)
        AND (refund_payout_encrypted IS NULL OR char_length(refund_payout_encrypted) <= 1000)
      ),
      CONSTRAINT chk_return_requests_refusal_reason CHECK (
        (status = 'refused') = (refusal_reason IS NOT NULL)
        AND (refusal_reason IS NULL OR refusal_reason IN ('seller_rejected', 'admin_rejected', 'dispute_upheld'))
      ),
      CONSTRAINT chk_return_requests_notes CHECK (
        (rejection_reason IS NULL OR char_length(rejection_reason) >= 3)
        AND (escalation_note IS NULL OR char_length(escalation_note) >= 3)
        AND (dispute_reason IS NULL OR char_length(dispute_reason) >= 3)
      ),
      -- What each status needs; the fields stay once set, so later statuses keep them.
      CONSTRAINT chk_return_requests_requested
        CHECK (status <> 'requested' OR seller_decision_deadline_at IS NOT NULL),
      CONSTRAINT chk_return_requests_rejected
        CHECK (status <> 'rejected' OR (rejection_reason IS NOT NULL AND escalation_deadline_at IS NOT NULL)),
      CONSTRAINT chk_return_requests_escalated CHECK (status <> 'escalated' OR escalation_note IS NOT NULL),
      CONSTRAINT chk_return_requests_approved CHECK (
        status NOT IN ('approved', 'picked_up', 'received', 'disputed', 'completed', 'pickup_failed')
        OR approved_at IS NOT NULL
      ),
      CONSTRAINT chk_return_requests_agent
        CHECK (status NOT IN ('picked_up', 'received', 'disputed', 'completed') OR agent_id IS NOT NULL),
      CONSTRAINT chk_return_requests_received CHECK (
        status NOT IN ('received', 'disputed', 'completed')
        OR (received_at IS NOT NULL AND inspection_deadline_at IS NOT NULL)
      ),
      CONSTRAINT chk_return_requests_disputed CHECK (status <> 'disputed' OR dispute_reason IS NOT NULL),
      CONSTRAINT chk_return_requests_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL))
    );

    -- One open return per seller order (RE-1); the request's 23505 → 409 RETURN_ALREADY_OPEN. Also
    -- getOpenReturnSellerOrderIds: WHERE seller_order_id = ANY(?) AND status IN (<open>).
    CREATE UNIQUE INDEX uq_return_requests_seller_order_id_open ON return_requests (seller_order_id)
      WHERE status IN ('requested', 'rejected', 'escalated', 'approved', 'picked_up', 'received', 'disputed');

    -- GET /returns: WHERE customer_id = ? [AND status ...] ORDER BY created_at DESC, id DESC.
    CREATE INDEX idx_return_requests_customer_id_created_at_id
      ON return_requests (customer_id, created_at DESC, id DESC);
    -- GET /seller/returns: WHERE seller_id = ? [AND status ...] ORDER BY created_at DESC, id DESC.
    CREATE INDEX idx_return_requests_seller_id_created_at_id
      ON return_requests (seller_id, created_at DESC, id DESC);
    -- GET /admin/returns without a party filter: ORDER BY created_at DESC, id DESC.
    CREATE INDEX idx_return_requests_created_at_id ON return_requests (created_at DESC, id DESC);

    -- Jobs (UC-RE-9): WHERE status = '<s>' AND <deadline> <= now() ORDER BY <deadline> LIMIT ?.
    CREATE INDEX idx_return_requests_seller_decision
      ON return_requests (seller_decision_deadline_at) WHERE status = 'requested';
    CREATE INDEX idx_return_requests_escalation
      ON return_requests (escalation_deadline_at) WHERE status = 'rejected';
    CREATE INDEX idx_return_requests_inspection
      ON return_requests (inspection_deadline_at) WHERE status = 'received';
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS return_requests;
    DROP SEQUENCE IF EXISTS return_number_seq;
  `);
}
