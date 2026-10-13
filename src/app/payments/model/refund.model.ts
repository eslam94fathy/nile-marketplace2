import { type Money } from '../../../lib/money';
import { type RefundReason, type RefundStatus } from '../enums';

/** A refund due; R1 refunds are done by hand in the Kashier dashboard, then recorded (spec 10 UC-PA-4). */
export interface PaymentRefund {
  id: string;
  paymentId: string;
  /** The payment's order (read with the refund for the admin views). */
  orderId: string;
  sellerOrderId: string | null;
  amount: Money;
  reason: RefundReason;
  status: RefundStatus;
  providerRefundRef: string | null;
  recordedByUserId: string | null;
  recordedAt: Date | null;
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
