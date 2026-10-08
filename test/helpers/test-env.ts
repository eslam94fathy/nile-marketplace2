import { generateKeyPairSync } from 'node:crypto';

/** One RSA key pair per test process, used to sign test JWTs and to configure JWT_PUBLIC_KEYS. */
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export const TEST_JWT_KID = 'test-k1';
export const TEST_JWT_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export const TEST_JWT_PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** A complete, valid environment. Integration tests override the connection URLs. */
export function testEnvInput(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    SERVICE_NAME: 'nile-test',
    LOG_LEVEL: 'fatal',
    PORT: '3000',
    HTTP_BODY_LIMIT_KB: '100',
    TRUST_PROXY_HOPS: '0',
    CORS_ALLOWED_ORIGINS: '',
    SHUTDOWN_TIMEOUT_MS: '5000',
    API_DOCS_ENABLED: 'true',
    HEALTH_CHECK_TIMEOUT_MS: '2000',
    PAGINATION_DEFAULT_LIMIT: '20',
    PAGINATION_MAX_LIMIT: '100',
    DATABASE_URL: 'postgres://nile:nile@localhost:5432/nile',
    DB_SSL: 'false',
    DB_POOL_MIN: '0',
    DB_POOL_MAX: '5',
    DB_STATEMENT_TIMEOUT_MS: '10000',
    REDIS_URL: 'redis://localhost:6379',
    REDIS_KEY_PREFIX: 'nile:test:',
    RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
    RABBITMQ_EXCHANGE: 'nile.events',
    RABBITMQ_PREFETCH: '10',
    MQ_RETRY_DELAYS_MS: '100,200',
    OUTBOX_DRAIN_INTERVAL_MS: '100',
    OUTBOX_BATCH_SIZE: '50',
    OUTBOX_MAX_BACKOFF_MS: '1000',
    OUTBOX_RETENTION_DAYS: '7',
    PROCESSED_EVENTS_RETENTION_DAYS: '30',
    CLEANUP_JOB_INTERVAL_MS: '86400000',
    JWT_ALGORITHM: 'RS256',
    JWT_ISSUER: 'nile-test',
    JWT_AUDIENCE: 'nile-test-app',
    JWT_PUBLIC_KEYS: JSON.stringify({ [TEST_JWT_KID]: TEST_JWT_PUBLIC_KEY_PEM }),
    RATE_LIMIT_GENERAL_POINTS: '1000',
    RATE_LIMIT_GENERAL_WINDOW_SECONDS: '60',
    RATE_LIMIT_STRICT_AUTH_POINTS: '5',
    RATE_LIMIT_STRICT_AUTH_WINDOW_SECONDS: '60',
    RATE_LIMIT_REFRESH_POINTS: '30',
    RATE_LIMIT_REFRESH_WINDOW_SECONDS: '60',
    RATE_LIMIT_CHECKOUT_POINTS: '10',
    RATE_LIMIT_CHECKOUT_WINDOW_SECONDS: '60',
    IDEMPOTENCY_TTL_HOURS: '24',
    IDEMPOTENCY_LOCK_TTL_SECONDS: '30',
    ...overrides,
  };
}
