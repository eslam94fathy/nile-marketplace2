import { defineEvent } from './define-event';

/** Publisher: payments. Consumers: none in R1. */
export interface PaymentRefundRecordedPayload {
  paymentId: string;
  orderId: string;
  refundId: string;
  amount: string;
  newPaymentStatus: 'partially_refunded_manually' | 'refunded_manually';
  recordedByUserId: string;
}

export const PaymentRefundRecorded = defineEvent<PaymentRefundRecordedPayload>(
  'payment.refund_recorded',
  1,
  'payment',
);
