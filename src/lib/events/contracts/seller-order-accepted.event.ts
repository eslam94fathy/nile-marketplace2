import { defineEvent } from './define-event';

/**
 * Publisher: ordering (UC-OR-3 accept, spec 09 §8.2). Consumers: realtime, notifications. No money or
 * stock effect.
 */
export interface SellerOrderAcceptedPayload {
  sellerOrderId: string;
  orderId: string;
  orderNumber: string;
  sellerId: string;
  customerId: string;
  /** ISO-8601. */
  acceptedAt: string;
}

export const SellerOrderAccepted = defineEvent<SellerOrderAcceptedPayload>(
  'seller_order.accepted',
  1,
  'seller_order',
);
