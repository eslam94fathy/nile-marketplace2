/** Values match `chk_return_requests_reason` (R-13). One reason per request (RE-4). */
export const ReturnReason = {
  DAMAGED: 'damaged',
  WRONG_ITEM: 'wrong_item',
  NOT_AS_DESCRIBED: 'not_as_described',
  CHANGED_MIND: 'changed_mind',
} as const;
export type ReturnReason = (typeof ReturnReason)[keyof typeof ReturnReason];

/** The seller pays the return fee and the request needs a photo (R-13, RE-2). */
export const SELLER_FAULT_REASONS: readonly ReturnReason[] = [
  ReturnReason.DAMAGED,
  ReturnReason.WRONG_ITEM,
  ReturnReason.NOT_AS_DESCRIBED,
];

/** Values match `chk_return_requests_status` (spec 18 §1.1). */
export const ReturnStatus = {
  REQUESTED: 'requested',
  REJECTED: 'rejected',
  ESCALATED: 'escalated',
  APPROVED: 'approved',
  PICKED_UP: 'picked_up',
  RECEIVED: 'received',
  DISPUTED: 'disputed',
  COMPLETED: 'completed',
  REFUSED: 'refused',
  CANCELLED: 'cancelled',
  PICKUP_FAILED: 'pickup_failed',
} as const;
export type ReturnStatus = (typeof ReturnStatus)[keyof typeof ReturnStatus];

/** Open = not terminal; matches `uq_return_requests_seller_order_id_open` (RE-1). */
export const OPEN_RETURN_STATUSES = [
  ReturnStatus.REQUESTED,
  ReturnStatus.REJECTED,
  ReturnStatus.ESCALATED,
  ReturnStatus.APPROVED,
  ReturnStatus.PICKED_UP,
  ReturnStatus.RECEIVED,
  ReturnStatus.DISPUTED,
] as const;
export type OpenReturnStatus = (typeof OPEN_RETURN_STATUSES)[number];

/** Values match `chk_return_requests_refusal_reason`. */
export const ReturnRefusalReason = {
  /** The escalation window lapsed after a seller rejection. */
  SELLER_REJECTED: 'seller_rejected',
  ADMIN_REJECTED: 'admin_rejected',
  DISPUTE_UPHELD: 'dispute_upheld',
} as const;
export type ReturnRefusalReason = (typeof ReturnRefusalReason)[keyof typeof ReturnRefusalReason];

/** Values match `chk_return_requests_return_fee_payer`. */
export const ReturnFeePayer = {
  SELLER: 'seller',
  CUSTOMER: 'customer',
} as const;
export type ReturnFeePayer = (typeof ReturnFeePayer)[keyof typeof ReturnFeePayer];

/** COD refunds only (RE-8). Values match `chk_return_requests_refund_payout_method`. */
export const RefundPayoutMethod = {
  MOBILE_WALLET: 'mobile_wallet',
  INSTAPAY: 'instapay',
} as const;
export type RefundPayoutMethod = (typeof RefundPayoutMethod)[keyof typeof RefundPayoutMethod];

/** Values match `chk_return_photos_uploaded_by`. */
export const PhotoUploader = {
  CUSTOMER: 'customer',
  SELLER: 'seller',
} as const;
export type PhotoUploader = (typeof PhotoUploader)[keyof typeof PhotoUploader];

/** Values match `chk_return_status_history_actor_role` and the event's `actor`. */
export const ReturnActorRole = {
  CUSTOMER: 'customer',
  SELLER: 'seller',
  ADMIN: 'admin',
  DELIVERY_AGENT: 'delivery_agent',
  SYSTEM: 'system',
} as const;
export type ReturnActorRole = (typeof ReturnActorRole)[keyof typeof ReturnActorRole];

/** `POST /admin/returns/:id/decide` (UC-RE-3). */
export const AdminReturnDecision = {
  APPROVE: 'approve',
  REJECT: 'reject',
} as const;
export type AdminReturnDecision = (typeof AdminReturnDecision)[keyof typeof AdminReturnDecision];
