import { defineEvent } from './define-event';

/** Publisher: payments. Consumers: none in R1. */
export interface PaymentRefundRecordedPayload {
  paymentId: string;
  orderId: string;
  refundId: string;
  amount: string;
  newPaymentStatus: 'partially_refunded' | 'refunded';
  recordedByUserId: string;
}

export const PaymentRefundRecorded = defineEvent<PaymentRefundRecordedPayload>(
  'payment.refund_recorded',
  1,
  'payment',
);
