import { type Knex } from 'knex';

// ordering: a seller-funded coupon lowers the seller's net by its discount (R-17, spec 09 §8.8), so the R1
// rule seller_net = subtotal - commission holds only without one (database D-26). Swapped NOT VALID and
// validated by the next migration (database §14.2).
const replaceCheck = (rule: string) => `
  ALTER TABLE seller_orders DROP CONSTRAINT chk_seller_orders_net;
  ALTER TABLE seller_orders ADD CONSTRAINT chk_seller_orders_net CHECK (${rule}) NOT VALID;
`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    replaceCheck(
      `seller_net = subtotal - commission - CASE WHEN discount_funding = 'seller' THEN discount_amount ELSE 0 END`,
    ),
  );
}

export async function down(knex: Knex): Promise<void> {
  // NOT VALID and left so: seller-funded rows written meanwhile stay.
  await knex.raw(replaceCheck('seller_net = subtotal - commission'));
}
