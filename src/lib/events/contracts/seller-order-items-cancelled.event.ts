import { defineEvent } from './define-event';
import { type ItemCancelReason, type PaymentMethod, type SellerOrderStatus } from './shared-types';

/** Publisher: ordering. Consumers: delivery, payments. */
export interface SellerOrderItemsCancelledPayload {
  sellerOrderId: string;
  orderId: string;
  sellerId: string;
  paymentMethod: PaymentMethod;
  /**
   * The seller order's status when the items were cancelled (unchanged by it): `ready_for_pickup`
   * tells delivery a shipment exists or is coming (spec 02 v1.1, DE-15).
   */
  previousStatus: SellerOrderStatus;
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
