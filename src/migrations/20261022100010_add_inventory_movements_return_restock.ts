import { type Knex } from 'knex';

// inventory: the return_restock movement (spec 07 §8, database v2.0 §14.11). reference_type has no CHECK,
// so 'return' needs nothing here. The type CHECK is replaced NOT VALID on the append-only table and
// validated by the next migration (database §14.2).
const R1_TYPES = `'seller_adjustment', 'reserve', 'release', 'commit'`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE inventory_movements DROP CONSTRAINT chk_inventory_movements_type;
    ALTER TABLE inventory_movements ADD CONSTRAINT chk_inventory_movements_type
      CHECK (type IN (${R1_TYPES}, 'return_restock')) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // NOT VALID and left so: return_restock rows written meanwhile stay (the table is append-only).
  await knex.raw(`
    ALTER TABLE inventory_movements DROP CONSTRAINT chk_inventory_movements_type;
    ALTER TABLE inventory_movements ADD CONSTRAINT chk_inventory_movements_type
      CHECK (type IN (${R1_TYPES})) NOT VALID;
  `);
}
