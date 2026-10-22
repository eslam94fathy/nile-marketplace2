import { defineEvent } from './define-event';
import { type ReturnActorValue, type ReturnStatusValue } from './shared-types';

/**
 * Publisher: returns (every transition, spec 18 §1.1). Consumers: realtime, notifications, delivery
 * (`to = cancelled` cancels the return shipment, spec 11 UC-DE-10).
 */
export interface ReturnStatusChangedPayload {
  returnId: string;
  returnNumber: string;
  orderId: string;
  orderNumber: string;
  sellerOrderId: string;
  customerId: string;
  sellerId: string;
  /** null on the request itself. */
  from: ReturnStatusValue | null;
  to: ReturnStatusValue;
  actor: ReturnActorValue;
}

export const ReturnStatusChanged = defineEvent<ReturnStatusChangedPayload>(
  'return.status_changed',
  1,
  'return_request',
);
