/**
 * The audit catalogue (docs/spec/20-backoffice.md §2.3): every admin write, the kind of row it
 * targets, and the only fields it may record. Like the event contracts in lib/events, it lives in
 * the shared kernel, so a module records audit rows without importing the audit module.
 * Each new action needs a migration that adds it to `chk_admin_audit_log_action`.
 */

/** `admin_audit_log.target_type` (spec 20 §2.1, CHECK `chk_admin_audit_log_target_type`). */
export const AuditTargetType = {
  USER: 'user',
  SELLER: 'seller',
  CATEGORY: 'category',
  ATTRIBUTE: 'attribute',
  OPTION: 'option',
  PRODUCT: 'product',
  GOVERNORATE: 'governorate',
  SETTING: 'setting',
  DELIVERY_AGENT: 'delivery_agent',
  SHIPMENT: 'shipment',
  ORDER: 'order',
  SELLER_ORDER: 'seller_order',
  PAYMENT_REFUND: 'payment_refund',
  COD_REMITTANCE: 'cod_remittance',
  PAYOUT: 'payout',
  SUPPORT_TICKET: 'support_ticket',
  REVIEW: 'review',
  REVIEW_REPLY: 'review_reply',
} as const;
export type AuditTargetType = (typeof AuditTargetType)[keyof typeof AuditTargetType];

interface AuditActionSpec {
  target: AuditTargetType;
  /** The allow-list: no secret ever appears here (passwords, tokens, OTPs, keys, payout details). */
  fields: readonly string[];
}

const T = AuditTargetType;
const STATUS = ['status'] as const;
const CATEGORY_FIELDS = ['name', 'slug', 'sortOrder', 'isActive', 'parentId'] as const;
const CATEGORY_IMAGE_FIELDS = ['imageMediaId', 'imageAltText'] as const;
const ATTRIBUTE_FIELDS = ['name', 'code', 'sortOrder', 'categoryId'] as const;
const OPTION_FIELDS = ['value', 'code', 'sortOrder', 'attributeId'] as const;
const AGENT_FIELDS = ['fullName', 'phone', 'homeGovernorateId', 'status'] as const;

export const AUDIT_ACTIONS = {
  // identity (spec 03 §4.10–§4.13, UC-ID-8)
  'admin.invited': { target: T.USER, fields: ['email', 'role'] },
  'admin.seeded': { target: T.USER, fields: ['email', 'role'] },
  'user.invite_resent': { target: T.USER, fields: [] },
  'user.suspended': { target: T.USER, fields: STATUS },
  'user.reactivated': { target: T.USER, fields: STATUS },
  // sellers (spec 05 UC-SE-3)
  'seller.approved': { target: T.SELLER, fields: STATUS },
  'seller.rejected': { target: T.SELLER, fields: STATUS },
  'seller.suspended': { target: T.SELLER, fields: STATUS },
  'seller.reinstated': { target: T.SELLER, fields: STATUS },
  'seller.commission_changed': { target: T.SELLER, fields: ['commissionRate'] },
  'setting.default_commission_changed': { target: T.SETTING, fields: ['defaultCommissionRate'] },
  // catalog (spec 06 UC-CA-1, UC-CA-2, UC-CA-9)
  'category.created': { target: T.CATEGORY, fields: CATEGORY_FIELDS },
  'category.updated': { target: T.CATEGORY, fields: CATEGORY_FIELDS },
  'category.image_set': { target: T.CATEGORY, fields: CATEGORY_IMAGE_FIELDS },
  'category.image_removed': { target: T.CATEGORY, fields: CATEGORY_IMAGE_FIELDS },
  'attribute.created': { target: T.ATTRIBUTE, fields: ATTRIBUTE_FIELDS },
  'attribute.updated': { target: T.ATTRIBUTE, fields: ATTRIBUTE_FIELDS },
  'attribute.deleted': { target: T.ATTRIBUTE, fields: ATTRIBUTE_FIELDS },
  'option.created': { target: T.OPTION, fields: OPTION_FIELDS },
  'option.updated': { target: T.OPTION, fields: OPTION_FIELDS },
  'option.deleted': { target: T.OPTION, fields: OPTION_FIELDS },
  // delivery (spec 11 UC-DE-4, UC-DE-6, UC-DE-7)
  'governorate.updated': { target: T.GOVERNORATE, fields: ['deliveryFee'] },
  'setting.delivery_changed': { target: T.SETTING, fields: ['agentFeeShareRate'] },
  'delivery_agent.created': { target: T.DELIVERY_AGENT, fields: AGENT_FIELDS },
  'delivery_agent.updated': { target: T.DELIVERY_AGENT, fields: AGENT_FIELDS },
  'delivery_agent.deactivated': { target: T.DELIVERY_AGENT, fields: AGENT_FIELDS },
  'delivery_agent.activated': { target: T.DELIVERY_AGENT, fields: AGENT_FIELDS },
  'shipment.admin_assigned': { target: T.SHIPMENT, fields: ['agentId'] },
  // payments (spec 10 UC-PA-4)
  'payment_refund.recorded': { target: T.PAYMENT_REFUND, fields: ['status', 'providerRefundRef'] },
  // support (spec 16 UC-SU-3, SU-5; an auto-assign on the first reply is an assign too, SU-18)
  'support_ticket.assigned': { target: T.SUPPORT_TICKET, fields: ['assignedAdminUserId'] },
  'support_ticket.resolved': { target: T.SUPPORT_TICKET, fields: STATUS },
  'support_ticket.closed': { target: T.SUPPORT_TICKET, fields: STATUS },
  // reviews (spec 17 UC-RV-4): the reason is the entry's `reason`
  'review.hidden': { target: T.REVIEW, fields: STATUS },
  'review.unhidden': { target: T.REVIEW, fields: STATUS },
  'review_reply.hidden': { target: T.REVIEW_REPLY, fields: ['hidden'] },
  'review_reply.unhidden': { target: T.REVIEW_REPLY, fields: ['hidden'] },
  // finance (spec 12 §1.3)
  'cod_remittance.recorded': { target: T.COD_REMITTANCE, fields: ['amount', 'agentId'] },
  'payout.recorded': {
    target: T.PAYOUT,
    fields: ['amount', 'payeeType', 'payeeId', 'externalReference'],
  },
} as const satisfies Record<string, AuditActionSpec>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as AuditAction[];

export function auditTargetOf(action: AuditAction): AuditTargetType {
  return AUDIT_ACTIONS[action].target;
}

export function auditFieldsOf(action: AuditAction): readonly string[] {
  return AUDIT_ACTIONS[action].fields;
}
