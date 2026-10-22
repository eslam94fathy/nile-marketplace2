import { type Knex } from 'knex';

// Second step of the NOT VALID CHECK on payments (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE payments VALIDATE CONSTRAINT chk_payments_status`);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down replaces it.
export async function down(): Promise<void> {}
