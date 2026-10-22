import { type Knex } from 'knex';

// notifications: the coupon_blocked type (spec 13 NO-35, spec 19 PR-20). Replaces
// chk_user_notifications_type with the longer list: added NOT VALID, then validated, so the swap takes no
// long lock (database §14.2).
const EARLIER_TYPES = `
  'order_placed', 'seller_order_received', 'seller_order_accepted', 'seller_order_cancelled',
  'payment_failed', 'shipment_assigned', 'out_for_delivery', 'delivery_attempt_failed', 'delivered',
  'support_reply', 'support_user_message', 'support_resolved',
  'review_received', 'review_replied', 'product_blocked',
  'return_requested', 'return_approved', 'return_rejected', 'return_picked_up', 'return_received',
  'return_completed', 'return_refused', 'refund_issued'`;

const replaceCheck = (types: string) => `
  ALTER TABLE user_notifications DROP CONSTRAINT chk_user_notifications_type;
  ALTER TABLE user_notifications
    ADD CONSTRAINT chk_user_notifications_type CHECK (type IN (${types})) NOT VALID;
`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ${replaceCheck(`${EARLIER_TYPES}, 'coupon_blocked'`)}
    ALTER TABLE user_notifications VALIDATE CONSTRAINT chk_user_notifications_type;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // NOT VALID and left so: coupon_blocked rows written meanwhile stay until retention removes them.
  await knex.raw(replaceCheck(EARLIER_TYPES));
}
