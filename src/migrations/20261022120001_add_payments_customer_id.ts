import { type Knex } from 'knex';

// payments: the order's customer on the payment (spec 10 PA-30, database D-25), so the refund events can
// carry `customerId` (spec 02 §6.5, spec 12 §8.5) without payments calling ordering. Filled from orders and
// then NOT NULL; nothing is in production yet, so the SET NOT NULL scan is short. Checkout passes it on
// every new payment.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE payments ADD COLUMN customer_id UUID;
    UPDATE payments p SET customer_id = o.customer_id FROM orders o WHERE o.id = p.order_id;
    ALTER TABLE payments ALTER COLUMN customer_id SET NOT NULL;
    -- Cross-module FK (D12). Customers are never deleted and nothing looks payments up by customer: no index.
    ALTER TABLE payments
      ADD CONSTRAINT fk_payments_customer_id FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE payments
      DROP CONSTRAINT IF EXISTS fk_payments_customer_id,
      DROP COLUMN IF EXISTS customer_id;
  `);
}
