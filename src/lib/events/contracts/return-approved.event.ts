import { defineEvent } from './define-event';
import { type DropoffSnapshot, type PaymentMethod, type PickupSnapshot } from './shared-types';

/**
 * Publisher: returns (UC-RE-4). Consumer: delivery (`delivery.return-updates`, UC-DE-8), which creates
 * the return shipment. `pickup` is the customer (the order's drop-off address), `dropoff` the seller
 * (its pickup address and business name); delivery stores them by party (spec 11 DE-21).
 */
export interface ReturnApprovedPayload {
  returnId: string;
  returnNumber: string;
  sellerOrderId: string;
  orderId: string;
  sellerId: string;
  /** The order's number and payment method, stored on the return shipment (spec 18 RE-23). */
  orderNumber: string;
  paymentMethod: PaymentMethod;
  pickup: DropoffSnapshot;
  dropoff: PickupSnapshot;
  /** Units to pick up. */
  itemCount: number;
  /** Money string: the fee snapshot taken at request time (RE-5). */
  returnFee: string;
  /** Rate string, e.g. "0.7000". */
  agentShareRate: string;
}

export const ReturnApproved = defineEvent<ReturnApprovedPayload>('return.approved', 1, 'return_request');
