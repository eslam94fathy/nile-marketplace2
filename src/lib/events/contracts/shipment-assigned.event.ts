import { defineEvent } from './define-event';

/** Publisher: delivery. Consumers: none in R1. */
export interface ShipmentAssignedPayload {
  shipmentId: string;
  sellerOrderId: string;
  agentId: string;
  previousAgentId: string | null;
  assignedBy: 'auto' | 'admin';
}

export const ShipmentAssigned = defineEvent<ShipmentAssignedPayload>('shipment.assigned', 1, 'shipment');
