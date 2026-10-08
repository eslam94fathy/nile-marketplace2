import { defineEvent } from './define-event';
import { type PaymentMethod } from './shared-types';

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
