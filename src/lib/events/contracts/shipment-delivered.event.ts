import { defineEvent } from './define-event';

/** Publisher: delivery. Consumer: ordering. */
export interface ShipmentDeliveredPayload {
  shipmentId: string;
  sellerOrderId: string;
  orderId: string;
  agentId: string;
  codCollectedAmount: string | null;
  deliveryFeeCollected: boolean;
  deliveryFeeAmount: string;
  deliveredAt: string;
}

export const ShipmentDelivered = defineEvent<ShipmentDeliveredPayload>('shipment.delivered', 1, 'shipment');
