import { defineEvent } from './define-event';

/** Publisher: delivery. Consumer: ordering. */
export interface ShipmentOutForDeliveryPayload {
  shipmentId: string;
  sellerOrderId: string;
  orderId: string;
  agentId: string;
  attemptNumber: 1 | 2 | 3;
}

export const ShipmentOutForDelivery = defineEvent<ShipmentOutForDeliveryPayload>(
  'shipment.out_for_delivery',
  1,
  'shipment',
);
