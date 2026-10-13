import { defineEvent } from './define-event';
import { type DropoffSnapshot, type PaymentMethod, type PickupSnapshot } from './shared-types';

/** Publisher: ordering. Consumer: delivery (creates the shipment from this snapshot). */
export interface SellerOrderReadyForPickupPayload {
  sellerOrderId: string;
  orderId: string;
  orderNumber: string;
  sellerId: string;
  paymentMethod: PaymentMethod;
  /** COD: current seller order subtotal. Kashier: "0.00". */
  codItemsAmount: string;
  /** COD fee of the whole checkout (used by the fee carrier). Kashier: "0.00". */
  orderDeliveryFee: string;
  pickup: PickupSnapshot;
  dropoff: DropoffSnapshot;
  readyAt: string;
}

export const SellerOrderReadyForPickup = defineEvent<SellerOrderReadyForPickupPayload>(
  'seller_order.ready_for_pickup',
  1,
  'seller_order',
);
