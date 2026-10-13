import { defineEvent } from './define-event';

/** Publisher: payments. Consumer: ordering. */
export interface PaymentFailedPayload {
  paymentId: string;
  orderId: string;
  reason: 'amount_mismatch' | 'order_reference_mismatch';
}

export const PaymentFailed = defineEvent<PaymentFailedPayload>('payment.failed', 1, 'payment');
