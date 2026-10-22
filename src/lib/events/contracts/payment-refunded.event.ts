import { defineEvent } from './define-event';
import { type RefundReasonValue } from './shared-types';

/**
 * Publisher: payments, when Kashier confirms an automated refund (spec 10 UC-PA-6). Consumers: finance
 * (`finance.ledger`, returns only), notifications, realtime.
 */
export interface PaymentRefundedPayload {
  paymentId: string;
  orderId: string;
  /** The order's customer (spec 02 §6.5, PA-30). */
  customerId: string;
  refundId: string;
  /** Set for a return refund. */
  returnId: string | null;
  reason: RefundReasonValue;
  amount: string;
  newPaymentStatus: 'partially_refunded' | 'refunded';
}

export const PaymentRefunded = defineEvent<PaymentRefundedPayload>('payment.refunded', 1, 'payment');
