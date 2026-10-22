import { type Knex } from 'knex';

// payments: automated Kashier refunds and COD return refunds (spec 10 §8.1, database v2.0 §14.12).
// method and attempt_count get temporary defaults that are dropped at once (DB-Q7): existing rows are R1
// manual refunds with no attempts (PA-29). The FK and CHECKs are NOT VALID; the next migration validates
// them (database §14.2).
const R1_REASONS = `'seller_order_cancelled', 'items_cancelled', 'delivery_failed', 'late_payment_after_expiry',
  'all_cancelled_fee', 'amount_mismatch'`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE payment_refunds
      ADD COLUMN return_id                UUID,
      ADD COLUMN method                   VARCHAR(20) NOT NULL DEFAULT 'manual',
      ADD COLUMN attempt_count            SMALLINT    NOT NULL DEFAULT 0,
      ADD COLUMN next_attempt_at          TIMESTAMPTZ,
      -- Redacted provider text of the last failed attempt (N-2 rule).
      ADD COLUMN last_error               VARCHAR(500),
      -- COD return refunds only: where the admin pays the customer (AES-256-GCM, S-1 key, RE-8).
      ADD COLUMN payout_details_encrypted TEXT,
      ADD COLUMN succeeded_at             TIMESTAMPTZ;
    ALTER TABLE payment_refunds
      ALTER COLUMN method DROP DEFAULT,
      ALTER COLUMN attempt_count DROP DEFAULT;

    ALTER TABLE payment_refunds
      DROP CONSTRAINT chk_payment_refunds_reason,
      DROP CONSTRAINT chk_payment_refunds_status,
      DROP CONSTRAINT chk_payment_refunds_recorded;
    ALTER TABLE payment_refunds
      -- Cross-module FK (D12); served by idx_payment_refunds_return_id.
      ADD CONSTRAINT fk_payment_refunds_return_id
        FOREIGN KEY (return_id) REFERENCES return_requests (id) ON DELETE RESTRICT NOT VALID,
      ADD CONSTRAINT chk_payment_refunds_reason CHECK (reason IN (${R1_REASONS}, 'return')) NOT VALID,
      ADD CONSTRAINT chk_payment_refunds_status CHECK (status IN (
        'pending_auto', 'processing', 'succeeded', 'pending_manual', 'recorded'
      )) NOT VALID,
      ADD CONSTRAINT chk_payment_refunds_method CHECK (method IN ('kashier_auto', 'manual')) NOT VALID,
      ADD CONSTRAINT chk_payment_refunds_attempt_count CHECK (attempt_count >= 0) NOT VALID,
      ADD CONSTRAINT chk_payment_refunds_return CHECK ((reason = 'return') = (return_id IS NOT NULL)) NOT VALID,
      ADD CONSTRAINT chk_payment_refunds_payout_details CHECK (
        payout_details_encrypted IS NULL
        OR (reason = 'return' AND char_length(payout_details_encrypted) <= 1000)
      ) NOT VALID,
      -- The job's queue always has a time to run.
      ADD CONSTRAINT chk_payment_refunds_next_attempt
        CHECK (status <> 'pending_auto' OR next_attempt_at IS NOT NULL) NOT VALID,
      -- recorded: by whom, when and the reference (UC-PA-4); succeeded: Kashier's reference and when
      -- (UC-PA-6); every open status: none of them.
      ADD CONSTRAINT chk_payment_refunds_outcome CHECK (
        (status = 'recorded' AND recorded_by_user_id IS NOT NULL AND recorded_at IS NOT NULL
          AND provider_refund_ref IS NOT NULL AND succeeded_at IS NULL)
        OR (status = 'succeeded' AND recorded_by_user_id IS NULL AND recorded_at IS NULL
          AND provider_refund_ref IS NOT NULL AND succeeded_at IS NOT NULL)
        OR (status IN ('pending_auto', 'processing', 'pending_manual') AND recorded_by_user_id IS NULL
          AND recorded_at IS NULL AND provider_refund_ref IS NULL AND succeeded_at IS NULL)
      ) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE payment_refunds
      DROP CONSTRAINT IF EXISTS chk_payment_refunds_outcome,
      DROP CONSTRAINT IF EXISTS chk_payment_refunds_next_attempt,
      DROP CONSTRAINT IF EXISTS chk_payment_refunds_payout_details,
      DROP CONSTRAINT IF EXISTS chk_payment_refunds_return,
      DROP CONSTRAINT IF EXISTS chk_payment_refunds_attempt_count,
      DROP CONSTRAINT IF EXISTS chk_payment_refunds_method,
      DROP CONSTRAINT IF EXISTS chk_payment_refunds_status,
      DROP CONSTRAINT IF EXISTS chk_payment_refunds_reason,
      DROP CONSTRAINT IF EXISTS fk_payment_refunds_return_id,
      DROP COLUMN IF EXISTS succeeded_at,
      DROP COLUMN IF EXISTS payout_details_encrypted,
      DROP COLUMN IF EXISTS last_error,
      DROP COLUMN IF EXISTS next_attempt_at,
      DROP COLUMN IF EXISTS attempt_count,
      DROP COLUMN IF EXISTS method,
      DROP COLUMN IF EXISTS return_id;
    -- NOT VALID: rows of the new statuses or reason written meanwhile stay.
    ALTER TABLE payment_refunds
      ADD CONSTRAINT chk_payment_refunds_reason CHECK (reason IN (${R1_REASONS})) NOT VALID,
      ADD CONSTRAINT chk_payment_refunds_status CHECK (status IN ('pending_manual', 'recorded')) NOT VALID,
      ADD CONSTRAINT chk_payment_refunds_recorded CHECK (
        (status = 'recorded' AND recorded_by_user_id IS NOT NULL AND recorded_at IS NOT NULL
          AND provider_refund_ref IS NOT NULL)
        OR (status = 'pending_manual' AND recorded_by_user_id IS NULL AND recorded_at IS NULL
          AND provider_refund_ref IS NULL)
      ) NOT VALID;
  `);
}
