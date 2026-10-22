import { defineEvent } from './define-event';
import { type PaymentMethod } from './shared-types';

/**
 * Publisher: returns (UC-RE-7). Consumers: payments (`payments.order-adjustments`, the refund) and
 * finance (`finance.ledger`, spec 12 §8.4). Money as strings.
 */
export interface ReturnCompletedPayload {
  returnId: string;
  sellerOrderId: string;
  orderId: string;
  customerId: string;
  sellerId: string;
  paymentMethod: PaymentMethod;
  itemsPaid: string;
  itemsSubtotal: string;
  commissionReversed: string;
  sellerNetReversed: string;
  platformDiscountReversed: string;
  returnFee: string;
  returnFeePayer: 'seller' | 'customer';
  agentId: string;
  agentFeeShare: string;
  refundAmount: string;
  /** COD only: the payout details sealed with the S-1 key, AAD `<returnId>:refund_payout` (RE-8). */
  refundPayoutEncrypted: string | null;
}

export const ReturnCompleted = defineEvent<ReturnCompletedPayload>('return.completed', 1, 'return_request');

/**
 * AAD of the sealed COD payout details (S-1 box, spec 02 §3.1): bound to the return, so a ciphertext can't
 * be moved to another request. Returns seals with it, payments opens with it (spec 10 §8.4).
 */
export const refundPayoutAad = (returnId: string): string => `${returnId}:refund_payout`;
