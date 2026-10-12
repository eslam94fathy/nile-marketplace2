import { PaymentStatus } from './enums';

export const PAYMENTS_TABLES = {
  PAYMENTS: 'payments',
  PAYMENT_REFUNDS: 'payment_refunds',
  PAYMENT_EVENTS: 'payment_events',
} as const;

/** Queue of the order-adjustments consumer (docs/spec/02-events.md §2). */
export const ORDER_ADJUSTMENTS_QUEUE = 'payments.order-adjustments';

/** COD payments whose amounts the order events still change (spec 10 UC-PA-3). */
export const COD_OPEN_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.PENDING,
  PaymentStatus.PARTIALLY_COLLECTED,
];

/**
 * Kashier payments that money was taken for and that are not fully refunded yet: only these get
 * refund rows (spec 10 UC-PA-3). A payment that never got paid ignores the order events.
 */
export const KASHIER_REFUNDABLE_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED_MANUALLY,
];
