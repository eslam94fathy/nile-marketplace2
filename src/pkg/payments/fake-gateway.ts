import { randomUUID } from 'node:crypto';
import { readKashierWebhook } from './kashier-webhook';
import {
  type CreateSessionInput,
  type IPaymentGateway,
  type PaymentSession,
  PaymentGatewayError,
  type PaymentGatewayErrorKind,
  type RefundInput,
  type RefundResult,
  type ProviderPaymentStatus,
  type SessionStatus,
  type WebhookNotification,
} from './payment-gateway.interface';

export interface FakeGatewayOptions {
  /** Signs and verifies webhooks exactly like Kashier, so the real verification path runs (PA-5). */
  apiKey: string;
  /** Prefix of the fake checkout URLs. */
  checkoutBaseUrl: string;
}

interface FakeSession {
  merchantOrderId: string;
  status: ProviderPaymentStatus;
  expiresAt: Date;
}

/**
 * In-memory stand-in for Kashier in local development and tests (spec 10 PA-5; refused in
 * staging/production by the env schema). Keeps Kashier's rules that matter to us: one open or paid
 * session per order (PA-12), statuses read by id, and Kashier-signed webhooks. Tests can script
 * outages and outcomes through the extra methods.
 */
export class FakePaymentGateway implements IPaymentGateway {
  private readonly sessions = new Map<string, FakeSession>();
  private outage: PaymentGatewayError | null = null;
  /** Calls to createSession, including refused ones (for tests). */
  createCalls = 0;
  /** Every refund call, in order (for tests). */
  readonly refundCalls: RefundInput[] = [];
  private readonly refunded = new Map<string, number>();
  private readonly scriptedRefunds: (PaymentGatewayErrorKind | 'replay')[] = [];
  private refundSequence = 0;
  private lastRefund: RefundResult | null = null;

  constructor(private readonly options: FakeGatewayOptions) {}

  createSession(input: CreateSessionInput): Promise<PaymentSession> {
    this.createCalls += 1;
    if (this.outage) return Promise.reject(this.outage);
    const now = Date.now();
    const blocking = [...this.sessions.values()].some(
      (s) =>
        s.merchantOrderId === input.merchantOrderId && (s.status === 'paid' || s.expiresAt.getTime() > now),
    );
    if (blocking) {
      return Promise.reject(
        new PaymentGatewayError('fake: another session is opened or paid', 'session_exists', 400),
      );
    }
    const sessionId = randomUUID().replace(/-/g, '').slice(0, 24);
    this.sessions.set(sessionId, {
      merchantOrderId: input.merchantOrderId,
      status: 'unpaid',
      expiresAt: input.expiresAt,
    });
    return Promise.resolve({
      sessionId,
      checkoutUrl: `${this.options.checkoutBaseUrl}/session/${sessionId}?mode=fake`,
      expiresAt: input.expiresAt,
    });
  }

  getSessionStatus(sessionId: string): Promise<SessionStatus> {
    if (this.outage) return Promise.reject(this.outage);
    const status = this.sessions.get(sessionId)?.status ?? 'unpaid';
    return Promise.resolve({ status, providerStatus: `FAKE_${status.toUpperCase()}` });
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): WebhookNotification | null {
    return readKashierWebhook(rawBody, signatureHeader, this.options.apiKey);
  }

  /**
   * Refunds like Kashier (K-8): a new transaction id each time and the running total, unless a scripted
   * outcome is queued: an error kind, or `replay` (the previous answer again, K-11).
   */
  refund(input: RefundInput): Promise<RefundResult> {
    this.refundCalls.push(input);
    if (this.outage) return Promise.reject(this.outage);
    const scripted = this.scriptedRefunds.shift();
    if (scripted === 'replay' && this.lastRefund) return Promise.resolve(this.lastRefund);
    if (scripted && scripted !== 'replay') {
      return Promise.reject(
        new PaymentGatewayError(`fake: refund ${scripted}`, scripted, scripted === 'rejected' ? 400 : null),
      );
    }
    const cents = Math.round(Number(input.amount) * 100) + (this.refunded.get(input.merchantOrderId) ?? 0);
    this.refunded.set(input.merchantOrderId, cents);
    this.refundSequence += 1;
    this.lastRefund = {
      refundTransactionId: `FAKE-RF-${this.refundSequence}`,
      totalRefundedAmount: (cents / 100).toFixed(2),
      providerStatus: 'PARTIALLY_REFUNDED',
    };
    return Promise.resolve(this.lastRefund);
  }

  /** Queues the outcome of the next refund calls (tests). */
  scriptRefund(...outcomes: (PaymentGatewayErrorKind | 'replay')[]): void {
    this.scriptedRefunds.push(...outcomes);
  }

  /** Scripts the session's provider-side outcome (what Kashier would report when asked). */
  setStatus(sessionId: string, status: ProviderPaymentStatus): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`fake: no session ${sessionId}`);
    session.status = status;
  }

  /** Every call fails as `unavailable` until `endOutage()` (timeouts, 5xx). */
  startOutage(): void {
    this.outage = new PaymentGatewayError('fake: provider unavailable', 'unavailable', 503);
  }

  endOutage(): void {
    this.outage = null;
  }
}
