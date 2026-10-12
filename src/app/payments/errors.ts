import { AppError } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** payments error codes (docs/spec/10-payments.md §6). */
export const PaymentsErrorCode = {
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  REFUND_NOT_FOUND: 'REFUND_NOT_FOUND',
  REFUND_ALREADY_RECORDED: 'REFUND_ALREADY_RECORDED',
} as const;
export type PaymentsErrorCode = (typeof PaymentsErrorCode)[keyof typeof PaymentsErrorCode];

const C = PaymentsErrorCode;
const S = HTTP_STATUS;

/** Missing or wrong signature: nothing is stored (PA-7). */
export const invalidWebhookSignature = () =>
  new AppError(C.INVALID_WEBHOOK_SIGNATURE, 'Invalid webhook signature', S.UNAUTHORIZED);

/** Kashier timed out, failed, or holds a session we never stored (PA-12). The app retries until expiry (SD-5). */
export const paymentProviderUnavailable = (cause?: unknown) =>
  new AppError(
    C.PAYMENT_PROVIDER_UNAVAILABLE,
    'The payment provider is unavailable, try again',
    S.BAD_GATEWAY,
    {
      cause,
    },
  );

export const paymentNotFound = () => new AppError(C.PAYMENT_NOT_FOUND, 'Payment not found', S.NOT_FOUND);

export const refundNotFound = () => new AppError(C.REFUND_NOT_FOUND, 'Refund not found', S.NOT_FOUND);

export const refundAlreadyRecorded = () =>
  new AppError(C.REFUND_ALREADY_RECORDED, 'This refund was already recorded', S.CONFLICT);
