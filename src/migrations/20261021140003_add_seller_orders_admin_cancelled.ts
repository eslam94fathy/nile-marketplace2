import { type Knex } from 'knex';

// ordering: a seller order cancelled by an admin (spec 09 §8.4, database v2.0 §14.11). The reason CHECK
// is replaced by a longer list, NOT VALID, and validated by the next migration (database §14.2).
const R1_REASONS = `'customer_cancelled', 'seller_cancelled', 'seller_acceptance_timeout', 'payment_failed', 'payment_expired'`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE seller_orders DROP CONSTRAINT chk_seller_orders_cancel_reason;
    ALTER TABLE seller_orders ADD CONSTRAINT chk_seller_orders_cancel_reason
      CHECK (cancel_reason IS NULL OR cancel_reason IN (${R1_REASONS}, 'admin_cancelled')) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // NOT VALID and left so: admin-cancelled rows written meanwhile stay.
  await knex.raw(`
    ALTER TABLE seller_orders DROP CONSTRAINT chk_seller_orders_cancel_reason;
    ALTER TABLE seller_orders ADD CONSTRAINT chk_seller_orders_cancel_reason
      CHECK (cancel_reason IS NULL OR cancel_reason IN (${R1_REASONS})) NOT VALID;
  `);
}
