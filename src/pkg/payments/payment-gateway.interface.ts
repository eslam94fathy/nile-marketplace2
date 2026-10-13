/** A hosted payment session for one payment (spec 10 §2, PA-12). */
export interface CreateSessionInput {
  /** Our payment id: the provider allows one open or paid session per value (PA-12). */
  merchantOrderId: string;
  /** Decimal string with 2 places, e.g. "150.00". */
  amount: string;
  currency: 'EGP';
  /** The provider stops accepting payment at this moment (spec 09 OR-6). */
  expiresAt: Date;
  /** Shown in the provider dashboard; never PII. */
  customerReference: string;
  description: string;
}

export interface PaymentSession {
  sessionId: string;
  checkoutUrl: string;
  expiresAt: Date;
}

/**
 * Our reading of a session (spec 10 PA-13): `paid` = money was taken; `pending` = an attempt is
 * in flight; `unpaid` = nothing was or will be taken on it.
 */
export type ProviderPaymentStatus = 'paid' | 'pending' | 'unpaid';

export interface SessionStatus {
  status: ProviderPaymentStatus;
  /** The provider's own status, for logs. */
  providerStatus: string;
}

/** A signed webhook, already verified, with only the fields we use (spec 10 UC-PA-1). */
export interface WebhookNotification {
  /** Provider event name, e.g. "pay" or "refund". */
  event: string;
  /** Dedupe id, stable across the provider's retries (PA-15). */
  eventId: string;
  transactionId: string;
  merchantOrderId: string;
  /** Read from the data, never from `event` alone (PA-1). */
  succeeded: boolean;
  /** Decimal string with 2 places. */
  amount: string;
  currency: string;
  /** The payload without card data or signatures, safe to store (spec 10 UC-PA-1 step 2). */
  storablePayload: Record<string, unknown>;
}

export type PaymentGatewayErrorKind =
  /** Timeout, network failure or 5xx: retrying later may work. */
  | 'unavailable'
  /** The provider refuses a second session while one is open or paid (PA-12). */
  | 'session_exists'
  /** Any other refusal (4xx): retrying the same request won't help. */
  | 'rejected';

export class PaymentGatewayError extends Error {
  override readonly name = 'PaymentGatewayError';

  constructor(
    message: string,
    readonly kind: PaymentGatewayErrorKind,
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * The payment provider (spec 10 §1, PA-5): Kashier in staging/production, a fake locally and in
 * tests. Every call is an HTTP call: never make one inside a DB transaction (CLAUDE.md §6.4).
 */
export interface IPaymentGateway {
  createSession(input: CreateSessionInput): Promise<PaymentSession>;
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
  /** null when the signature is missing or wrong, or the body isn't a webhook we can read (PA-7). */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): WebhookNotification | null;
}
