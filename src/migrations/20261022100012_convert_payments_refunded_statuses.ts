import { type Knex } from 'knex';

// payments: partially_refunded / refunded replace the _manually statuses (spec 10 §8.1, PA-23). Nothing is
// in production yet, so the rows are converted and the old values dropped in one go (PA-28, D-23) instead
// of the expand / contract of database §14.2. The CHECK is NOT VALID; the next migration validates it.
const COD = `method = 'cod' AND status IN ('pending', 'partially_collected', 'collected', 'cancelled')`;
const KASHIER_R1 = `'initiated', 'paid', 'failed', 'expired', 'partially_refunded_manually', 'refunded_manually'`;
const KASHIER_R2 = `'initiated', 'paid', 'failed', 'expired', 'partially_refunded', 'refunded'`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE payments DROP CONSTRAINT chk_payments_status;
    UPDATE payments SET status = 'partially_refunded', updated_at = now()
      WHERE status = 'partially_refunded_manually';
    UPDATE payments SET status = 'refunded', updated_at = now() WHERE status = 'refunded_manually';
    ALTER TABLE payments ADD CONSTRAINT chk_payments_status
      CHECK ((${COD}) OR (method = 'kashier' AND status IN (${KASHIER_R2}))) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE payments DROP CONSTRAINT chk_payments_status;
    UPDATE payments SET status = 'partially_refunded_manually', updated_at = now()
      WHERE status = 'partially_refunded';
    UPDATE payments SET status = 'refunded_manually', updated_at = now() WHERE status = 'refunded';
    ALTER TABLE payments ADD CONSTRAINT chk_payments_status
      CHECK ((${COD}) OR (method = 'kashier' AND status IN (${KASHIER_R1}))) NOT VALID;
  `);
}
