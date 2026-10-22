/** Header names used by the API (CLAUDE.md §5: no magic strings). */
export const HEADER = {
  CORRELATION_ID: 'X-Correlation-Id',
  IDEMPOTENCY_KEY: 'Idempotency-Key',
  IDEMPOTENT_REPLAYED: 'Idempotent-Replayed',
  RETRY_AFTER: 'Retry-After',
  AUTHORIZATION: 'Authorization',
  CONTENT_TYPE: 'Content-Type',
  /** `web` selects the refresh-token cookie (spec 03 §8.1). */
  NILE_CLIENT: 'X-Nile-Client',
} as const;

export const UUID_ANY_VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
