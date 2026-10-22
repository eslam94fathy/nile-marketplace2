import { defineEvent } from './define-event';
import { type CouponFunding, type PaymentMethod } from './shared-types';

/** Publisher: ordering. Consumers: payments, finance (books the whole delivery atomically). */
export interface SellerOrderDeliveredPayload {
  sellerOrderId: string;
  orderId: string;
  sellerId: string;
  paymentMethod: PaymentMethod;
  subtotal: string;
  commissionRate: string;
  commission: string;
  sellerNet: string;
  /** The coupon share of the delivered units (spec 02 §6.5); "0.00" without one. */
  discountAmount: string;
  discountFunding: CouponFunding | null;
  /** `discountAmount` when the platform funds it, else "0.00": finance's row 8 (spec 12 §8.2). */
  platformDiscount: string;
  agentId: string;
  /** Computed by ordering (docs/spec/09-ordering.md §3.8). */
  agentFeeShare: string;
  /** COD: cash the agent took (items + fee if this shipment carried it). Kashier: null. */
  codCollectedAmount: string | null;
  deliveryFeeCollected: boolean;
  /** The fee collected by this shipment, "0.00" if none. */
  deliveryFeeAmount: string;
  deliveredAt: string;
}

export const SellerOrderDelivered = defineEvent<SellerOrderDeliveredPayload>(
  'seller_order.delivered',
  1,
  'seller_order',
);
