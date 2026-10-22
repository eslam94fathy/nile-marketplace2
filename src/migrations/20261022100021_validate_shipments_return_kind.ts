import { type Knex } from 'knex';

// Second step of the NOT VALID FK and CHECKs on shipments (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE shipments VALIDATE CONSTRAINT fk_shipments_return_id;
    ALTER TABLE shipments VALIDATE CONSTRAINT chk_shipments_kind;
    ALTER TABLE shipments VALIDATE CONSTRAINT chk_shipments_return_id;
    ALTER TABLE shipments VALIDATE CONSTRAINT chk_shipments_status;
    ALTER TABLE shipments VALIDATE CONSTRAINT chk_shipments_kind_status;
    ALTER TABLE shipments VALIDATE CONSTRAINT chk_shipments_return_no_cash;
  `);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down replaces them.
export async function down(): Promise<void> {}
