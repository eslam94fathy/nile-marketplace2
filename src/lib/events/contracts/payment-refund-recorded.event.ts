import { defineEvent } from './define-event';
import { type RefundReasonValue } from './shared-types';

/** Publisher: payments (UC-PA-4). Consumers: finance (returns only, spec 12 §8.5), notifications, realtime. */
export interface PaymentRefundRecordedPayload {
  paymentId: string;
  orderId: string;
  refundId: string;
  /** The order's customer (spec 02 §6.5, PA-30). */
  customerId: string;
  reason: RefundReasonValue;
  /** Set for a return refund. */
  returnId: string | null;
  amount: string;
  /** Kashier: the payment's new status; COD keeps its status (spec 10 §8.6). */
  newPaymentStatus: 'partially_refunded' | 'refunded' | null;
  recordedByUserId: string;
}

export const PaymentRefundRecorded = defineEvent<PaymentRefundRecordedPayload>(
  'payment.refund_recorded',
  1,
  'payment',
);
