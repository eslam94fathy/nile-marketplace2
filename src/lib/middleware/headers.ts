/** Header names used by the API (CLAUDE.md §5: no magic strings). */
export const HEADER = {
  CORRELATION_ID: 'X-Correlation-Id',
  IDEMPOTENCY_KEY: 'Idempotency-Key',
  IDEMPOTENT_REPLAYED: 'Idempotent-Replayed',
  RETRY_AFTER: 'Retry-After',
  AUTHORIZATION: 'Authorization',
} as const;

export const UUID_ANY_VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
