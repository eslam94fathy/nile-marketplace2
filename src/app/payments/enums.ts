/** Values match `chk_payments_method` and the `PaymentMethod` event type (spec 10 §1). */
export const PaymentMethod = {
  COD: 'cod',
  KASHIER: 'kashier',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

/** Values match `chk_payments_status`: the first four are COD's, the rest Kashier's (spec 10 §1). */
export const PaymentStatus = {
  PENDING: 'pending',
  PARTIALLY_COLLECTED: 'partially_collected',
  COLLECTED: 'collected',
  CANCELLED: 'cancelled',
  INITIATED: 'initiated',
  PAID: 'paid',
  FAILED: 'failed',
  EXPIRED: 'expired',
  PARTIALLY_REFUNDED_MANUALLY: 'partially_refunded_manually',
  REFUNDED_MANUALLY: 'refunded_manually',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** Values match `chk_payment_refunds_reason` (spec 10 §1, PA-6). */
export const RefundReason = {
  SELLER_ORDER_CANCELLED: 'seller_order_cancelled',
  ITEMS_CANCELLED: 'items_cancelled',
  DELIVERY_FAILED: 'delivery_failed',
  LATE_PAYMENT_AFTER_EXPIRY: 'late_payment_after_expiry',
  ALL_CANCELLED_FEE: 'all_cancelled_fee',
  AMOUNT_MISMATCH: 'amount_mismatch',
} as const;
export type RefundReason = (typeof RefundReason)[keyof typeof RefundReason];

/** Values match `chk_payment_refunds_status`. */
export const RefundStatus = {
  PENDING_MANUAL: 'pending_manual',
  RECORDED: 'recorded',
} as const;
export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];
