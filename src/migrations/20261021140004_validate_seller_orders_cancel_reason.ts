import { type Knex } from 'knex';

// Second step of the replaced cancel-reason CHECK (database §14.2): VALIDATE takes only a SHARE UPDATE
// EXCLUSIVE lock.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE seller_orders VALIDATE CONSTRAINT chk_seller_orders_cancel_reason`);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down replaces it.
export async function down(): Promise<void> {}
