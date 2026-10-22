import { defineEvent } from './define-event';

/**
 * Publisher: delivery (spec 11 UC-DE-9). Consumers: returns (`returns.shipment-updates`), realtime.
 * Ordering never receives them: the names differ from the delivery events (spec 11 §8.5).
 */
export interface ReturnShipmentPayload {
  shipmentId: string;
  returnId: string;
  /** The returned seller order and its order (spec 11 DE-27). */
  sellerOrderId: string;
  orderId: string;
  agentId: string;
  /** ISO-8601: when it happened. */
  at: string;
}

/** The agent took the parcel from the customer. */
export const ReturnShipmentPickedUp = defineEvent<ReturnShipmentPayload>(
  'return_shipment.picked_up',
  1,
  'shipment',
);

/** The agent handed the parcel to the seller. */
export const ReturnShipmentDelivered = defineEvent<ReturnShipmentPayload>(
  'return_shipment.delivered',
  1,
  'shipment',
);

/** The pickup attempts ended (3 failures, or the customer refused): the shipment is cancelled. */
export const ReturnShipmentFailed = defineEvent<ReturnShipmentPayload>(
  'return_shipment.failed',
  1,
  'shipment',
);
