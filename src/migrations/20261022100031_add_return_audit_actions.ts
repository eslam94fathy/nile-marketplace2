import { type Knex } from 'knex';

// audit: the R2-P6 admin actions and the return_request target (spec 18 UC-RE-3, UC-RE-8, spec 10 §8.4,
// spec 20 §2.3). Replaces chk_admin_audit_log_action and chk_admin_audit_log_target_type with the longer
// lists: added NOT VALID, then validated, so the swap takes no long lock (database §14.2).
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
  'support_ticket.assigned', 'support_ticket.resolved', 'support_ticket.closed',
  'review.hidden', 'review.unhidden', 'review_reply.hidden', 'review_reply.unhidden',
  'seller_order.admin_cancelled', 'order.admin_cancelled', 'product.blocked', 'product.unblocked'`;

const RETURN_ACTIONS = `'return.admin_decided', 'return.dispute_resolved', 'payment_refund.retried'`;

const EARLIER_TARGETS = `
  'user', 'seller', 'category', 'attribute', 'option', 'product', 'governorate', 'setting',
  'delivery_agent', 'shipment', 'order', 'seller_order', 'payment_refund', 'cod_remittance',
  'payout', 'support_ticket', 'review', 'review_reply'`;

const replaceChecks = (actions: string, targets: string) => `
  ALTER TABLE admin_audit_log
    DROP CONSTRAINT chk_admin_audit_log_action,
    DROP CONSTRAINT chk_admin_audit_log_target_type;
  ALTER TABLE admin_audit_log
    ADD CONSTRAINT chk_admin_audit_log_action CHECK (action IN (${actions})) NOT VALID,
    ADD CONSTRAINT chk_admin_audit_log_target_type CHECK (target_type IN (${targets})) NOT VALID;
`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ${replaceChecks(`${EARLIER_ACTIONS}, ${RETURN_ACTIONS}`, `${EARLIER_TARGETS}, 'return_request'`)}
    ALTER TABLE admin_audit_log VALIDATE CONSTRAINT chk_admin_audit_log_action;
    ALTER TABLE admin_audit_log VALIDATE CONSTRAINT chk_admin_audit_log_target_type;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // NOT VALID and left so: rows of these actions written meanwhile stay (the log is append-only).
  await knex.raw(replaceChecks(EARLIER_ACTIONS, EARLIER_TARGETS));
}
