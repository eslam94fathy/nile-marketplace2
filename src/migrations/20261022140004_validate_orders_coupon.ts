import { type Knex } from 'knex';

// Second step of the NOT VALID FK and CHECK on orders (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_coupon_id;
    ALTER TABLE orders VALIDATE CONSTRAINT chk_orders_discount;
  `);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down drops them.
export async function down(): Promise<void> {}
