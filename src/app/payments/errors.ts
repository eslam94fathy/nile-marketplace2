/**
 * payments error codes (docs/spec/10-payments.md §6). Their factories land with the code that throws
 * them: the webhook, sessions and the admin refund endpoints (plan §7.5 PR b).
 */
export const PaymentsErrorCode = {
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  REFUND_NOT_FOUND: 'REFUND_NOT_FOUND',
  REFUND_ALREADY_RECORDED: 'REFUND_ALREADY_RECORDED',
} as const;
export type PaymentsErrorCode = (typeof PaymentsErrorCode)[keyof typeof PaymentsErrorCode];
