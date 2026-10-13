import { createHmac, timingSafeEqual } from 'node:crypto';
import { type WebhookNotification } from './payment-gateway.interface';

/** Header Kashier puts the webhook signature in (spec 10 UC-PA-1). */
export const KASHIER_SIGNATURE_HEADER = 'x-kashier-signature';

const SUCCESS_STATUS = 'SUCCESS';
const HEX_SHA256 = /^[0-9a-f]{64}$/i;
/**
 * Every field we act on must be among the signed ones (spec 10 PA-21): `signatureKeys` comes from the
 * request itself, so an unsigned field could have been changed in transit.
 */
const REQUIRED_SIGNED_FIELDS = ['merchantOrderId', 'status', 'amount', 'currency', 'transactionId'] as const;
/** Never stored: card data, hashes and signatures (spec 10 UC-PA-1 step 2). */
const UNSTORABLE_KEY = /card|cvv|^pan$|hash|signature|token|secret|apikey/i;

/**
 * The string Kashier signs: the `data` fields named in `signatureKeys`, sorted by name, as
 * `name=encodeURIComponent(value)` joined with `&` (verified against live webhooks by the sibling
 * service; spec 10 PA-1). A missing value signs as an empty string.
 */
export function kashierSignedString(
  data: Readonly<Record<string, unknown>>,
  signatureKeys: readonly string[],
): string {
  return [...signatureKeys]
    .sort()
    .map((key) => `${key}=${encodeURIComponent(signedValue(data[key]))}`)
    .join('&');
}

/** Signed fields are plain values; an object (never seen in Kashier webhooks) signs as its JSON. */
function signedValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/** HMAC-SHA256 (hex) keyed by the payment API key. Also used by the fake and the dev webhook script. */
export function signKashierWebhook(
  data: Readonly<Record<string, unknown>>,
  signatureKeys: readonly string[],
  apiKey: string,
): string {
  return createHmac('sha256', apiKey).update(kashierSignedString(data, signatureKeys), 'utf8').digest('hex');
}

/**
 * Verifies and reads a Kashier webhook body (spec 10 UC-PA-1 steps 1–2). Constant-time compare;
 * `data.hash` is ignored (PA-1). Returns null for anything we can't trust or read.
 */
export function readKashierWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  apiKey: string,
): WebhookNotification | null {
  if (!signatureHeader || !HEX_SHA256.test(signatureHeader)) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(envelope) || typeof envelope.event !== 'string' || !isRecord(envelope.data)) return null;
  const { data } = envelope;
  const keys = data.signatureKeys;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k): k is string => typeof k === 'string')) {
    return null;
  }
  if (!REQUIRED_SIGNED_FIELDS.every((field) => keys.includes(field))) return null;

  const expected = Buffer.from(signKashierWebhook(data, keys, apiKey), 'hex');
  const given = Buffer.from(signatureHeader, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const { transactionId, merchantOrderId, status, amount, currency } = data;
  if (
    typeof transactionId !== 'string' ||
    typeof merchantOrderId !== 'string' ||
    typeof currency !== 'string'
  ) {
    return null;
  }
  const money = toMoneyString(amount);
  if (money === null || typeof status !== 'string') return null;
  return {
    event: envelope.event,
    eventId: `${envelope.event}:${transactionId}`,
    transactionId,
    merchantOrderId,
    succeeded: status.toUpperCase() === SUCCESS_STATUS,
    amount: money,
    currency,
    storablePayload: { event: envelope.event, data: storable(data) },
  };
}

/** Kashier sends amounts as JSON numbers (or numeric strings); we keep exactly 2 decimals. */
function toMoneyString(value: unknown): string | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return null;
  const cents = Math.round(number * 100);
  if (Math.abs(cents - number * 100) > 1e-6) return null; // more than 2 decimals: not a money amount
  return (cents / 100).toFixed(2);
}

function storable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(storable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !UNSTORABLE_KEY.test(key))
      .map(([key, inner]) => [key, storable(inner)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
