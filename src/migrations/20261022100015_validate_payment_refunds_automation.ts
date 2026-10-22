import { type Knex } from 'knex';

// Second step of the NOT VALID FK and CHECKs on payment_refunds (database §14.2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE payment_refunds VALIDATE CONSTRAINT fk_payment_refunds_return_id;
    ALTER TABLE payment_refunds VALIDATE CONSTRAINT chk_payment_refunds_reason;
    ALTER TABLE payment_refunds VALIDATE CONSTRAINT chk_payment_refunds_status;
    ALTER TABLE payment_refunds VALIDATE CONSTRAINT chk_payment_refunds_method;
    ALTER TABLE payment_refunds VALIDATE CONSTRAINT chk_payment_refunds_attempt_count;
    ALTER TABLE payment_refunds VALIDATE CONSTRAINT chk_payment_refunds_return;
    ALTER TABLE payment_refunds VALIDATE CONSTRAINT chk_payment_refunds_payout_details;
    ALTER TABLE payment_refunds VALIDATE CONSTRAINT chk_payment_refunds_next_attempt;
    ALTER TABLE payment_refunds VALIDATE CONSTRAINT chk_payment_refunds_outcome;
  `);
}

// A validated constraint can't be marked NOT VALID again; the previous migration's down drops them.
export async function down(): Promise<void> {}
