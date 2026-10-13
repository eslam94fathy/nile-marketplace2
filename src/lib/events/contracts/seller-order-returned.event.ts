import { defineEvent } from './define-event';
import { type PaymentMethod } from './shared-types';

/** Publisher: ordering (seller confirmed the parcel came back). Consumers: delivery, payments. */
export interface SellerOrderReturnedPayload {
  sellerOrderId: string;
  orderId: string;
  sellerId: string;
  paymentMethod: PaymentMethod;
  subtotal: string;
  returnedAt: string;
}

export const SellerOrderReturned = defineEvent<SellerOrderReturnedPayload>(
  'seller_order.returned',
  1,
  'seller_order',
);
