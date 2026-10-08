import { defineEvent } from './define-event';
import { type ItemCancelReason, type PaymentMethod } from './shared-types';

/** Publisher: ordering. Consumers: delivery, payments. */
export interface SellerOrderItemsCancelledPayload {
  sellerOrderId: string;
  orderId: string;
  sellerId: string;
  paymentMethod: PaymentMethod;
  lines: { orderItemId: string; variantId: string; quantity: number; amount: string }[];
  amountCancelled: string;
  newSubtotal: string;
  newCommission: string;
  newSellerNet: string;
  reason: ItemCancelReason;
}

export const SellerOrderItemsCancelled = defineEvent<SellerOrderItemsCancelledPayload>(
  'seller_order.items_cancelled',
  1,
  'seller_order',
);
