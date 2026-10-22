import { defineEvent } from './define-event';

/** Publisher: delivery. Consumers: notifications, realtime. A return shipment has `kind = return` (spec 11 §8.2). */
export interface ShipmentAssignedPayload {
  shipmentId: string;
  sellerOrderId: string;
  agentId: string;
  previousAgentId: string | null;
  assignedBy: 'auto' | 'admin';
  kind: 'delivery' | 'return';
  /** Set for a return shipment. */
  returnId: string | null;
}

export const ShipmentAssigned = defineEvent<ShipmentAssignedPayload>('shipment.assigned', 1, 'shipment');
