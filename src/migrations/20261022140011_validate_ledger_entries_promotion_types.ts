import { type Knex } from 'knex';

// Second step of the NOT VALID CHECK on ledger_entries (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE ledger_entries VALIDATE CONSTRAINT chk_ledger_entries_entry_type`);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down replaces it.
export async function down(): Promise<void> {}
