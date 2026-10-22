import { type Knex } from 'knex';

// delivery: the history records pickup_failed too (spec 11 §8.1). The two CHECKs are replaced NOT VALID
// on the append-only table and validated by the next migration (database §14.2).
const R1_STATUSES = `'unassigned', 'assigned', 'picked_up', 'out_for_delivery', 'delivery_failed',
  'returning_to_seller', 'returned_to_seller', 'delivered', 'cancelled'`;

const replaceChecks = (statuses: string) => `
  ALTER TABLE shipment_status_history
    DROP CONSTRAINT chk_shipment_status_history_from_status,
    DROP CONSTRAINT chk_shipment_status_history_to_status;
  ALTER TABLE shipment_status_history
    ADD CONSTRAINT chk_shipment_status_history_from_status
      CHECK (from_status IS NULL OR from_status IN (${statuses})) NOT VALID,
    ADD CONSTRAINT chk_shipment_status_history_to_status CHECK (to_status IN (${statuses})) NOT VALID;
`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(replaceChecks(`${R1_STATUSES}, 'pickup_failed'`));
}

export async function down(knex: Knex): Promise<void> {
  // NOT VALID and left so: pickup_failed rows written meanwhile stay (the table is append-only).
  await knex.raw(replaceChecks(R1_STATUSES));
}
