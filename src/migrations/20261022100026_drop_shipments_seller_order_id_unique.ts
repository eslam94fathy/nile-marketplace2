import { type Knex } from 'knex';

// delivery: a seller order may now have return shipments besides its delivery, so the whole-table
// uniqueness goes; uq_shipments_seller_order_id_delivery keeps one delivery per seller order (spec 11
// §8.1, database v2.0 §14.12).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE shipments DROP CONSTRAINT uq_shipments_seller_order_id`);
}

// Fails once a seller order has a return shipment: rolling back past returns needs them removed first.
export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    `ALTER TABLE shipments ADD CONSTRAINT uq_shipments_seller_order_id UNIQUE (seller_order_id)`,
  );
}
