import { defineEvent } from './define-event';

/** Publisher: payments (inside ordering's expiry transaction). Consumers: none in R1. */
export interface PaymentExpiredPayload {
  paymentId: string;
  orderId: string;
  expiredAt: string;
}

export const PaymentExpired = defineEvent<PaymentExpiredPayload>('payment.expired', 1, 'payment');
