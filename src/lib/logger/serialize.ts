/**
 * Turns arbitrary log data into JSON-safe values:
 * redacts secrets, masks emails/phones, serialises Errors, survives cycles and BigInt.
 */

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;
const MAX_STRING_LENGTH = 4_000;

/** Keys whose values are never logged (compared lower-cased, without `_`/`-`). */
const SECRET_KEYS = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'invitetoken',
  'authorization',
  'cookie',
  'setcookie',
  'otp',
  'secret',
  'clientsecret',
  'apikey',
  'apisecret',
  'privatekey',
  'encryptedsecrets',
  'cardnumber',
  'cvv',
  'body',
  'headers',
]);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at < 1) return REDACTED;
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

export function maskPhone(value: string): string {
  if (value.length < 6) return REDACTED;
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 6)}${value.slice(-2)}`;
}

function maskByKey(key: string, value: unknown): unknown {
  const normalised = normaliseKey(key);
  if (SECRET_KEYS.has(normalised)) return REDACTED;
  if (typeof value === 'string') {
    if (normalised.includes('email')) return maskEmail(value);
    if (normalised.includes('phone')) return maskPhone(value);
  }
  return undefined;
}

function serializeError(error: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  const code = (error as { code?: unknown }).code;
  if (code !== undefined) out.code = toSafe(code, seen, depth + 1);
  if (error.stack) out.stack = error.stack;
  if (error.cause !== undefined) out.cause = toSafe(error.cause, seen, depth + 1);
  return out;
}

export function toSafe(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]` : value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'symbol':
      return value.toString();
    case 'function':
      return '[Function]';
    default:
      break;
  }
  const obj = value;
  if (seen.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;

  seen.add(obj);
  try {
    if (value instanceof Error) return serializeError(value, seen, depth);
    if (Array.isArray(value)) return value.map((item) => toSafe(item, seen, depth + 1));
    if (value instanceof Map) return toSafe(Object.fromEntries(value), seen, depth);
    if (value instanceof Set) return toSafe([...value], seen, depth);

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const masked = maskByKey(key, item);
      out[key] = masked !== undefined ? masked : toSafe(item, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Applies key-based masking to a top-level field set, then makes it JSON-safe. */
export function sanitizeFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return toSafe(fields) as Record<string, unknown>;
}
