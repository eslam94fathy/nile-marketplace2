import { type Knex } from 'knex';

// Second step of the NOT VALID CHECK on inventory_movements (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE inventory_movements VALIDATE CONSTRAINT chk_inventory_movements_type`);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down replaces it.
export async function down(): Promise<void> {}
