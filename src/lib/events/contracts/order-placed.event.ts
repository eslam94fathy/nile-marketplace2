import { defineEvent } from './define-event';
import { type PaymentMethod } from './shared-types';

/** Publisher: ordering. Consumers: none in R1. */
export interface OrderPlacedPayload {
  orderId: string;
  orderNumber: string;
  customerId: string;
  paymentMethod: PaymentMethod;
  sellerOrderIds: string[];
  itemsTotal: string;
  deliveryFee: string;
  total: string;
  placedAt: string;
}

export const OrderPlaced = defineEvent<OrderPlacedPayload>('order.placed', 1, 'order');
