import { defineEvent } from './define-event';
import { type PaymentMethod, type SellerOrderCancelReason, type SellerOrderStatus } from './shared-types';

/** Publisher: ordering. Consumers: delivery, payments. */
export interface SellerOrderCancelledPayload {
  sellerOrderId: string;
  orderId: string;
  sellerId: string;
  paymentMethod: PaymentMethod;
  previousStatus: SellerOrderStatus;
  reason: SellerOrderCancelReason;
  /** Subtotal at the time of cancellation. */
  amountCancelled: string;
  cancelledAt: string;
}

export const SellerOrderCancelled = defineEvent<SellerOrderCancelledPayload>(
  'seller_order.cancelled',
  1,
  'seller_order',
);
