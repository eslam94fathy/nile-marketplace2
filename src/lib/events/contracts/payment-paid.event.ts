import { defineEvent } from './define-event';

/** Publisher: payments. Consumer: ordering. */
export interface PaymentPaidPayload {
  paymentId: string;
  orderId: string;
  amount: string;
  paidAt: string;
  /** SD-5: true → the order stays cancelled and a full refund is flagged. */
  lateAfterExpiry: boolean;
}

export const PaymentPaid = defineEvent<PaymentPaidPayload>('payment.paid', 1, 'payment');
