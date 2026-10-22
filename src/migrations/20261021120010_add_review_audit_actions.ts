import { type Knex } from 'knex';

// audit: the review moderation actions (spec 17 UC-RV-4, spec 20 §2.3). Replaces chk_admin_audit_log_action
// with the longer list: added NOT VALID, then validated, so the swap takes no long lock (database v2.0 §14.2).
const EARLIER_ACTIONS = `
  'admin.invited', 'admin.seeded', 'user.invite_resent', 'user.suspended', 'user.reactivated',
  'seller.approved', 'seller.rejected', 'seller.suspended', 'seller.reinstated',
  'seller.commission_changed', 'setting.default_commission_changed',
  'category.created', 'category.updated', 'category.image_set', 'category.image_removed',
  'attribute.created', 'attribute.updated', 'attribute.deleted',
  'option.created', 'option.updated', 'option.deleted',
  'governorate.updated', 'setting.delivery_changed',
  'delivery_agent.created', 'delivery_agent.updated', 'delivery_agent.deactivated',
  'delivery_agent.activated', 'shipment.admin_assigned',
  'payment_refund.recorded', 'cod_remittance.recorded', 'payout.recorded',
  'support_ticket.assigned', 'support_ticket.resolved', 'support_ticket.closed'`;

const REVIEW_ACTIONS = `'review.hidden', 'review.unhidden', 'review_reply.hidden', 'review_reply.unhidden'`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE admin_audit_log DROP CONSTRAINT chk_admin_audit_log_action;
    ALTER TABLE admin_audit_log ADD CONSTRAINT chk_admin_audit_log_action
      CHECK (action IN (${EARLIER_ACTIONS}, ${REVIEW_ACTIONS})) NOT VALID;
    ALTER TABLE admin_audit_log VALIDATE CONSTRAINT chk_admin_audit_log_action;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // NOT VALID and left so: review rows written meanwhile stay (the log is append-only).
  await knex.raw(`
    ALTER TABLE admin_audit_log DROP CONSTRAINT chk_admin_audit_log_action;
    ALTER TABLE admin_audit_log ADD CONSTRAINT chk_admin_audit_log_action
      CHECK (action IN (${EARLIER_ACTIONS})) NOT VALID;
  `);
}
