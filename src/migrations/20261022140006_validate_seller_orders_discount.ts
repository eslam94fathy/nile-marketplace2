import { type Knex } from 'knex';

// Second step of the NOT VALID CHECKs on seller_orders (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE seller_orders VALIDATE CONSTRAINT chk_seller_orders_discount_funding;
    ALTER TABLE seller_orders VALIDATE CONSTRAINT chk_seller_orders_discount;
  `);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down drops them.
export async function down(): Promise<void> {}
