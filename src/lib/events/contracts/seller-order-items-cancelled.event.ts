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
  /** `amount`: what the customer paid for these units, after their coupon share (spec 09 §8.8). */
  lines: { orderItemId: string; variantId: string; quantity: number; amount: string }[];
  /** Paid amount (spec 02 §6.5). */
  amountCancelled: string;
  /** Undiscounted. */
  newSubtotal: string;
  /** What the customer still pays for the seller order's items: delivery's COD amount (R2-P7). */
  newPaidSubtotal: string;
  newCommission: string;
  newSellerNet: string;
  reason: ItemCancelReason;
}

export const SellerOrderItemsCancelled = defineEvent<SellerOrderItemsCancelledPayload>(
  'seller_order.items_cancelled',
  1,
  'seller_order',
);
