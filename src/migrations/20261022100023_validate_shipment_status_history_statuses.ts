import { type Knex } from 'knex';

// Second step of the NOT VALID CHECKs on shipment_status_history (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE shipment_status_history VALIDATE CONSTRAINT chk_shipment_status_history_from_status;
    ALTER TABLE shipment_status_history VALIDATE CONSTRAINT chk_shipment_status_history_to_status;
  `);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down replaces them.
export async function down(): Promise<void> {}
