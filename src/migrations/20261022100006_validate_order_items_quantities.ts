import { type Knex } from 'knex';

// Second step of the NOT VALID CHECK on order_items (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE order_items VALIDATE CONSTRAINT chk_order_items_quantities`);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down drops it.
export async function down(): Promise<void> {}
