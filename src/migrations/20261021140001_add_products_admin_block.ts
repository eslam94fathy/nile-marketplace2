import { type Knex } from 'knex';

// catalog: the admin product block (spec 20 §3.4, BO-6, database v2.0 §14.4). Nullable columns (null =
// not blocked, the stated reason): no default, no rewrite. The CHECK is added NOT VALID and validated by
// the next migration, so the live table takes no long lock (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE products
      ADD COLUMN admin_blocked_at   TIMESTAMPTZ,
      ADD COLUMN admin_block_reason VARCHAR(500);
    ALTER TABLE products
      ADD CONSTRAINT chk_products_admin_block CHECK (
        (admin_blocked_at IS NULL) = (admin_block_reason IS NULL)
        AND (admin_block_reason IS NULL OR char_length(admin_block_reason) >= 3)
      ) NOT VALID;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE products
      DROP CONSTRAINT IF EXISTS chk_products_admin_block,
      DROP COLUMN IF EXISTS admin_block_reason,
      DROP COLUMN IF EXISTS admin_blocked_at;
  `);
}
