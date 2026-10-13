import { type Money } from '../../../lib/money';
import { KASHIER_REFUNDABLE_STATUSES, COD_OPEN_STATUSES } from '../constants';
import { PaymentMethod, type PaymentStatus } from '../enums';

/** One payment per checkout (spec 10 §1). Amounts are EGP. */
export interface Payment {
  id: string;
  orderId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amount: Money;
  collectedAmount: Money;
  refundedAmount: Money;
  /** The Kashier session (PA-3): all three set together, or none. */
  session: { id: string; url: string; expiresAt: Date } | null;
  providerTransactionRef: string | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What ordering's order views read (spec 10 §2 `getSummaries`). Amounts are decimal strings. */
export interface PaymentSummary {
  orderId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amount: string;
  collectedAmount: string;
  refundedAmount: string;
}

export const toSummary = (payment: Payment): PaymentSummary => ({
  orderId: payment.orderId,
  method: payment.method,
  status: payment.status,
  amount: payment.amount.toString(),
  collectedAmount: payment.collectedAmount.toString(),
  refundedAmount: payment.refundedAmount.toString(),
});

export const isOpenCod = (payment: Payment): boolean =>
  payment.method === PaymentMethod.COD && COD_OPEN_STATUSES.includes(payment.status);

export const isRefundableKashier = (payment: Payment): boolean =>
  payment.method === PaymentMethod.KASHIER && KASHIER_REFUNDABLE_STATUSES.includes(payment.status);
