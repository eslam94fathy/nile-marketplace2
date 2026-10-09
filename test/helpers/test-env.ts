import { generateKeyPairSync, randomBytes } from 'node:crypto';

/** One RSA key pair per test process, used to sign test JWTs and to configure JWT_PUBLIC_KEYS. */
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export const TEST_JWT_KID = 'test-k1';
export const TEST_JWT_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export const TEST_JWT_PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

export const TEST_SECRETS_KEY_ID = 'test-s1';
export const TEST_SECRETS_KEY = randomBytes(32);

/**
 * A complete, valid environment for EVERY process (api, worker, migrate, seed-admin):
 * each per-process schema keeps only its own keys. Integration tests override the connection URLs.
 */
export function testEnvInput(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    // common
    NODE_ENV: 'test',
    SERVICE_NAME: 'nile-test',
    LOG_LEVEL: 'fatal',
    SHUTDOWN_TIMEOUT_MS: '5000',
    HEALTH_CHECK_TIMEOUT_MS: '2000',
    // database / redis / broker
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
    // worker jobs
    OUTBOX_DRAIN_INTERVAL_MS: '100',
    OUTBOX_BATCH_SIZE: '50',
    OUTBOX_MAX_BACKOFF_MS: '1000',
    OUTBOX_RETENTION_DAYS: '7',
    PROCESSED_EVENTS_RETENTION_DAYS: '30',
    CODES_RETENTION_DAYS: '30',
    CLEANUP_JOB_INTERVAL_MS: '86400000',
    // http
    PORT: '3000',
    HTTP_BODY_LIMIT_KB: '100',
    TRUST_PROXY_HOPS: '0',
    CORS_ALLOWED_ORIGINS: '',
    API_DOCS_ENABLED: 'true',
    PAGINATION_DEFAULT_LIMIT: '20',
    PAGINATION_MAX_LIMIT: '100',
    // jwt
    JWT_ALGORITHM: 'RS256',
    JWT_ISSUER: 'nile-test',
    JWT_AUDIENCE: 'nile-test-app',
    JWT_PUBLIC_KEYS: JSON.stringify({ [TEST_JWT_KID]: TEST_JWT_PUBLIC_KEY_PEM }),
    JWT_PRIVATE_KEY: TEST_JWT_PRIVATE_KEY_PEM,
    JWT_ACTIVE_KID: TEST_JWT_KID,
    ACCESS_TOKEN_TTL_MINUTES: '15',
    REFRESH_TOKEN_TTL_DAYS: '30',
    // rate limits / idempotency
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
    // identity (cost 10 = the minimum allowed, keeps tests fast)
    BCRYPT_COST: '10',
    OTP_TTL_MINUTES: '10',
    OTP_MAX_ATTEMPTS: '5',
    OTP_RESEND_COOLDOWN_SECONDS: '60',
    INVITE_TTL_HOURS: '72',
    INVITE_URL_BASE: 'https://app.nile.test/invite',
    // customers
    CUSTOMER_MAX_ADDRESSES: '20',
    // delivery reference data
    GOVERNORATES_CACHE_TTL_SECONDS: '3600',
    // secrets in event payloads
    SECRETS_ENCRYPTION_KEYS: JSON.stringify({ [TEST_SECRETS_KEY_ID]: TEST_SECRETS_KEY.toString('base64') }),
    SECRETS_ENCRYPTION_ACTIVE_KEY_ID: TEST_SECRETS_KEY_ID,
    // email (tests swap the sender for an in-memory fake through DI)
    EMAIL_PROVIDER: 'mailpit',
    EMAIL_HTTP_TIMEOUT_MS: '2000',
    MAILJET_FROM_EMAIL: 'no-reply@nile.test',
    MAILJET_FROM_NAME: 'Nile Test',
    MAILPIT_URL: 'http://localhost:8025',
    ...overrides,
  };
}
