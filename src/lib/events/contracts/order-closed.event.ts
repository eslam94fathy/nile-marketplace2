import { defineEvent } from './define-event';
import { type PaymentMethod } from './shared-types';

/** Publisher: ordering (every seller order of the checkout is terminal). Consumers: payments, finance. */
export interface OrderClosedPayload {
  orderId: string;
  customerId: string;
  paymentMethod: PaymentMethod;
  finalStatus: 'completed' | 'partially_completed' | 'cancelled';
  deliveredItemsTotal: string;
  /** Final fee: "0.00" when nothing was delivered (Q-28). */
  deliveryFee: string;
  originalDeliveryFee: string;
  closedAt: string;
}

export const OrderClosed = defineEvent<OrderClosedPayload>('order.closed', 1, 'order');
