/** Values match `chk_payments_method` and the `PaymentMethod` event type (spec 10 §1). */
export const PaymentMethod = {
  COD: 'cod',
  KASHIER: 'kashier',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

/**
 * Values match `chk_payments_status`: the first four are COD's, the rest Kashier's (spec 10 §1). How a
 * refund was done is on the refund row (spec 10 §8.1, PA-23).
 */
export const PaymentStatus = {
  PENDING: 'pending',
  PARTIALLY_COLLECTED: 'partially_collected',
  COLLECTED: 'collected',
  CANCELLED: 'cancelled',
  INITIATED: 'initiated',
  PAID: 'paid',
  FAILED: 'failed',
  EXPIRED: 'expired',
  PARTIALLY_REFUNDED: 'partially_refunded',
  REFUNDED: 'refunded',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** Values match `chk_payment_refunds_reason` (spec 10 §1, PA-6, §8.1). */
export const RefundReason = {
  SELLER_ORDER_CANCELLED: 'seller_order_cancelled',
  ITEMS_CANCELLED: 'items_cancelled',
  DELIVERY_FAILED: 'delivery_failed',
  LATE_PAYMENT_AFTER_EXPIRY: 'late_payment_after_expiry',
  ALL_CANCELLED_FEE: 'all_cancelled_fee',
  AMOUNT_MISMATCH: 'amount_mismatch',
  RETURN: 'return',
} as const;
export type RefundReason = (typeof RefundReason)[keyof typeof RefundReason];

/**
 * Values match `chk_payment_refunds_status` (spec 10 §8.1): the job works `pending_auto` and
 * `processing` into `succeeded`; an admin records `pending_manual` ones.
 */
export const RefundStatus = {
  PENDING_AUTO: 'pending_auto',
  PROCESSING: 'processing',
  SUCCEEDED: 'succeeded',
  PENDING_MANUAL: 'pending_manual',
  RECORDED: 'recorded',
} as const;
export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];

/** Values match `chk_payment_refunds_method` (spec 10 §8.1): how the refund was created to be done. */
export const RefundMethod = {
  KASHIER_AUTO: 'kashier_auto',
  MANUAL: 'manual',
} as const;
export type RefundMethod = (typeof RefundMethod)[keyof typeof RefundMethod];
