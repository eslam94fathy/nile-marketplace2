import { PaymentStatus } from './enums';

export const PAYMENTS_TABLES = {
  PAYMENTS: 'payments',
  PAYMENT_REFUNDS: 'payment_refunds',
  PAYMENT_EVENTS: 'payment_events',
} as const;

/** Paths under /api/v1 (spec 10 §4). The webhook path also appears in http-app.ts (raw body). */
export const PAYMENTS_PATHS = {
  KASHIER_WEBHOOK: '/webhooks/kashier',
  REFUNDS: '/admin/payments/refunds',
  REFUND: '/admin/payments/refunds/:refundId',
  RECORD_REFUND: '/admin/payments/refunds/:refundId/record',
  RETRY_REFUND: '/admin/payments/refunds/:refundId/retry',
  PAYMENT: '/admin/payments/:paymentId',
  ORDER_PAYMENT: '/admin/orders/:orderId/payment',
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
  PaymentStatus.PARTIALLY_REFUNDED,
];

/** K-11: no refund for a payment within this many minutes of another attempt (Kashier replays ~60 s). */
export const REFUND_SPACING_MINUTES = 2;

/** §8.3: the wait after the 1st, 2nd, … transient failure; the last one repeats until the attempts run out. */
export const REFUND_BACKOFF_MINUTES: readonly number[] = [1, 5, 30, 120, 360];

/** Log event codes of the refund job (spec 10 §8.3, K-10…K-12). */
export const RefundLogEvent = {
  SUCCEEDED: 'PAYMENT_REFUND_SUCCEEDED',
  RETRY: 'PAYMENT_REFUND_RETRY',
  GAVE_UP: 'PAYMENT_REFUND_GAVE_UP',
  REJECTED: 'PAYMENT_REFUND_REJECTED',
  OUTCOME_UNKNOWN: 'PAYMENT_REFUND_OUTCOME_UNKNOWN',
  REPLAYED: 'PAYMENT_REFUND_REPLAYED',
} as const;
