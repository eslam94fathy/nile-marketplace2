import { defineEvent } from './define-event';

/** Publisher: delivery. Consumer: ordering. */
export interface ShipmentPickedUpPayload {
  shipmentId: string;
  sellerOrderId: string;
  orderId: string;
  agentId: string;
  pickedUpAt: string;
}

export const ShipmentPickedUp = defineEvent<ShipmentPickedUpPayload>('shipment.picked_up', 1, 'shipment');
