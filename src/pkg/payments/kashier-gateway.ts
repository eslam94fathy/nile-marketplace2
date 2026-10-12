import { readKashierWebhook } from './kashier-webhook';
import {
  type CreateSessionInput,
  type IPaymentGateway,
  type PaymentSession,
  PaymentGatewayError,
  type ProviderPaymentStatus,
  type SessionStatus,
  type WebhookNotification,
} from './payment-gateway.interface';

export const KASHIER_TEST_BASE_URL = 'https://test-api.kashier.io';
export const KASHIER_LIVE_BASE_URL = 'https://api.kashier.io';

export interface KashierOptions {
  baseUrl: string;
  merchantId: string;
  /** The `api-key` header and the webhook HMAC key (spec 10 PA-1). */
  apiKey: string;
  /** The `Authorization` header value. */
  secretKey: string;
  /** Where Kashier sends webhooks for each session (`serverWebhook`). */
  webhookUrl: string;
  /** Where the customer returns to after paying (`merchantRedirect`, PA-8). */
  redirectUrl: string;
  timeoutMs: number;
}

/** Fixed request fields (spec 10 PA-14): one-off card / wallet payments with 3-D Secure. */
const SESSION_DEFAULTS = {
  paymentType: 'credit',
  type: 'one-time',
  allowedMethods: 'card,wallet',
  enable3DS: true,
  // Stay on Kashier's page after a failed attempt, so the customer can retry inside the window (S-4).
  failureRedirect: false,
  interactionSource: 'ECOMMERCE',
} as const;

/** Kashier's answer when the `order` already has an open or paid session (PA-12). */
const SESSION_EXISTS_MESSAGE = /another session is opened or paid/i;

/** Kashier statuses that mean money was taken (spec 10 PA-13). */
const PAID = new Set(['PAID', 'AUTHORIZED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING']);
const IN_FLIGHT = new Set(['PENDING']);

export function toProviderStatus(kashierStatus: string): ProviderPaymentStatus {
  if (PAID.has(kashierStatus)) return 'paid';
  if (IN_FLIGHT.has(kashierStatus)) return 'pending';
  return 'unpaid';
}

/**
 * Kashier v3 payment sessions (spec 10 §1, PA-11…PA-15; verified against the test environment
 * 2026-10-12). Error messages never carry our credentials, and the create response (which echoes the
 * merchant's api key) is never logged or stored.
 */
export class KashierPaymentGateway implements IPaymentGateway {
  constructor(private readonly options: KashierOptions) {}

  async createSession(input: CreateSessionInput): Promise<PaymentSession> {
    const response = await this.request('POST', '/v3/payment/sessions', {
      auth: true,
      body: {
        ...SESSION_DEFAULTS,
        merchantId: this.options.merchantId,
        amount: input.amount,
        currency: input.currency,
        order: input.merchantOrderId,
        expireAt: input.expiresAt.toISOString(),
        serverWebhook: this.options.webhookUrl,
        merchantRedirect: this.options.redirectUrl,
        description: input.description,
        customer: { reference: input.customerReference },
      },
    });
    const { _id: sessionId, sessionUrl, expireAt } = response;
    if (typeof sessionId !== 'string' || typeof sessionUrl !== 'string') {
      throw new PaymentGatewayError(
        'kashier: session response without _id or sessionUrl',
        'unavailable',
        200,
      );
    }
    const expiresAt = typeof expireAt === 'string' ? new Date(expireAt) : input.expiresAt;
    return {
      sessionId,
      checkoutUrl: sessionUrl,
      expiresAt: Number.isNaN(expiresAt.getTime()) ? input.expiresAt : expiresAt,
    };
  }

  /** The unauthenticated read (PA-13): not behind Kashier's IP allow-list. */
  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const response = await this.request('GET', `/v3/payment/sessions/${encodeURIComponent(sessionId)}`, {
      auth: false,
    });
    const data = response.data;
    const status = isRecord(data) ? data.status : undefined;
    if (typeof status !== 'string') {
      throw new PaymentGatewayError('kashier: session read without a status', 'unavailable', 200);
    }
    return { status: toProviderStatus(status), providerStatus: status };
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): WebhookNotification | null {
    return readKashierWebhook(rawBody, signatureHeader, this.options.apiKey);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: { auth: boolean; body?: unknown },
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.auth) {
      headers['api-key'] = this.options.apiKey;
      headers.Authorization = this.options.secretKey;
    }
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      throw new PaymentGatewayError(
        `kashier ${method} ${path.split('/').slice(0, 4).join('/')} unreachable`,
        'unavailable',
        null,
        { cause },
      );
    }

    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // Kashier answers some unknown routes with HTML.
    }
    if (response.ok && isRecord(json)) return json;
    throw new PaymentGatewayError(
      `kashier ${method} responded ${response.status}: ${describeError(json, text)}`,
      kindOf(response.status, json),
      response.status,
    );
  }
}

function kindOf(status: number, body: unknown): 'unavailable' | 'session_exists' | 'rejected' {
  if (status >= 500 || status === 429 || status === 200) return 'unavailable';
  if (SESSION_EXISTS_MESSAGE.test(describeError(body, ''))) return 'session_exists';
  return 'rejected';
}

/** Kashier's English error message, or a short excerpt; never a request header. */
function describeError(body: unknown, text: string): string {
  if (isRecord(body)) {
    const messages = body.messages;
    if (isRecord(messages) && typeof messages.en === 'string') return messages.en;
    if (typeof body.message === 'string') return body.message;
  }
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
