import { defineEvent } from './define-event';
import { type AttemptFailureReason } from './shared-types';

/** Publisher: delivery. Consumer: ordering. */
export interface ShipmentAttemptFailedPayload {
  shipmentId: string;
  sellerOrderId: string;
  orderId: string;
  agentId: string;
  attemptNumber: 1 | 2 | 3;
  reason: AttemptFailureReason;
  /** true when refused or after the 3rd attempt. */
  returningToSeller: boolean;
}

export const ShipmentAttemptFailed = defineEvent<ShipmentAttemptFailedPayload>(
  'shipment.attempt_failed',
  1,
  'shipment',
);
