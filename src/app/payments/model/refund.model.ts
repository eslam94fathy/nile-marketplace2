import { type Money } from '../../../lib/money';
import { type RefundMethod, type RefundReason, type RefundStatus } from '../enums';

/**
 * A refund due (spec 10 §1, §8.1). Kashier refunds are done by the job (UC-PA-6) or by hand in the Kashier
 * dashboard and recorded (UC-PA-4); COD return refunds are paid by an admin and recorded.
 */
export interface PaymentRefund {
  id: string;
  paymentId: string;
  /** The payment's order (read with the refund for the admin views). */
  orderId: string;
  sellerOrderId: string | null;
  /** Set for a return refund (reason `return`). */
  returnId: string | null;
  amount: Money;
  reason: RefundReason;
  status: RefundStatus;
  method: RefundMethod;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  /** COD return refunds carry sealed payout details; only the refund detail opens them. */
  hasPayoutDetails: boolean;
  providerRefundRef: string | null;
  recordedByUserId: string | null;
  recordedAt: Date | null;
  succeededAt: Date | null;
  createdAt: Date;
}

/** One webhook in the inbox, without its payload (spec 10 §4.2 `AdminPaymentDto.events`). */
export interface PaymentEventSummary {
  id: string;
  eventType: string;
  signatureValid: boolean;
  processedAt: Date | null;
  createdAt: Date;
}

/** What a return view shows of its refund (spec 10 §8.5). */
export type ReturnRefundStatus = 'pending' | 'processing' | 'succeeded' | 'manual';
export interface ReturnRefundView {
  status: ReturnRefundStatus;
  amount: Money;
  refundedAt: Date | null;
}
