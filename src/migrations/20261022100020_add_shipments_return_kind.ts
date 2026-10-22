import { type Knex } from 'knex';

// delivery: return shipments (spec 11 §8.1, database v2.0 §14.12, D-24). kind gets a temporary default
// that is dropped at once (DB-Q7): existing rows are deliveries. The snapshot columns keep their party
// for every kind (DE-21): pickup_* is always the seller, dropoff_* always the customer; a return runs
// from the dropoff address to the pickup address. payment_method stays the order's real method, and a
// return collects nothing (DE-22). The FK and CHECKs are NOT VALID; the next migration validates them
// (database §14.2).
const R1_STATUSES = `'unassigned', 'assigned', 'picked_up', 'out_for_delivery', 'delivery_failed',
  'returning_to_seller', 'returned_to_seller', 'delivered', 'cancelled'`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE shipments
      ADD COLUMN kind      VARCHAR(10) NOT NULL DEFAULT 'delivery',
      ADD COLUMN return_id UUID;
    ALTER TABLE shipments ALTER COLUMN kind DROP DEFAULT;

    ALTER TABLE shipments DROP CONSTRAINT chk_shipments_status;
    ALTER TABLE shipments
      -- Cross-module FK (D12); served by uq_shipments_return_id.
      ADD CONSTRAINT fk_shipments_return_id
        FOREIGN KEY (return_id) REFERENCES return_requests (id) ON DELETE RESTRICT NOT VALID,
      ADD CONSTRAINT chk_shipments_kind CHECK (kind IN ('delivery', 'return')) NOT VALID,
      ADD CONSTRAINT chk_shipments_return_id CHECK ((kind = 'return') = (return_id IS NOT NULL)) NOT VALID,
      ADD CONSTRAINT chk_shipments_status CHECK (status IN (${R1_STATUSES}, 'pickup_failed')) NOT VALID,
      -- A return uses unassigned → assigned → picked_up → delivered, pickup_failed and cancelled only
      -- (spec 11 §8.1); a delivery never fails a pickup.
      ADD CONSTRAINT chk_shipments_kind_status CHECK (
        (kind = 'delivery' AND status <> 'pickup_failed')
        OR (kind = 'return'
            AND status IN ('unassigned', 'assigned', 'picked_up', 'pickup_failed', 'delivered', 'cancelled'))
      ) NOT VALID,
      ADD CONSTRAINT chk_shipments_return_no_cash CHECK (
        kind = 'delivery'
        OR (cod_items_amount = 0 AND order_delivery_fee = 0 AND NOT carries_delivery_fee
            AND cod_collected_amount IS NULL)
      ) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE shipments
      DROP CONSTRAINT IF EXISTS chk_shipments_return_no_cash,
      DROP CONSTRAINT IF EXISTS chk_shipments_kind_status,
      DROP CONSTRAINT IF EXISTS chk_shipments_status,
      DROP CONSTRAINT IF EXISTS chk_shipments_return_id,
      DROP CONSTRAINT IF EXISTS chk_shipments_kind,
      DROP CONSTRAINT IF EXISTS fk_shipments_return_id,
      DROP COLUMN IF EXISTS return_id,
      DROP COLUMN IF EXISTS kind;
    -- NOT VALID: pickup_failed rows written meanwhile stay.
    ALTER TABLE shipments ADD CONSTRAINT chk_shipments_status CHECK (status IN (${R1_STATUSES})) NOT VALID;
  `);
}
