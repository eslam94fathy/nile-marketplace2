import { generateKeyPairSync, randomBytes } from 'node:crypto';
import webPush from 'web-push';

/** One RSA key pair per test process, used to sign test JWTs and to configure JWT_PUBLIC_KEYS. */
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export const TEST_JWT_KID = 'test-k1';
export const TEST_JWT_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export const TEST_JWT_PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** One VAPID key pair per test process (spec 13 §8.6). */
export const TEST_VAPID_KEYS = webPush.generateVAPIDKeys();

export const TEST_SECRETS_KEY_ID = 'test-s1';
export const TEST_SECRETS_KEY = randomBytes(32);
/** Signs the fake gateway's webhooks in tests (spec 10 PA-5). */
export const TEST_KASHIER_API_KEY = 'test-kashier-api-key';

/**
 * A complete, valid environment for EVERY process (api, worker, realtime, migrate, seed-admin):
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
    // Upload rate limit, per user (spec 14 ME-6)
    RATE_LIMIT_UPLOAD_POINTS: '1000',
    RATE_LIMIT_UPLOAD_WINDOW_SECONDS: '600',
    RATE_LIMIT_SUPPORT_MESSAGE_POINTS: '1000',
    RATE_LIMIT_SUPPORT_MESSAGE_WINDOW_SECONDS: '60',
    // realtime gateway (spec 15 §6)
    RATE_LIMIT_REALTIME_CONNECT_POINTS: '1000',
    RATE_LIMIT_REALTIME_CONNECT_WINDOW_SECONDS: '60',
    REALTIME_SIGNAL_RATE_PER_SECOND: '5',
    // notification centre retention (worker, spec 13 UC-NO-5)
    NOTIFICATION_RETENTION_DAYS: '90',
    JOB_NOTIFICATION_RETENTION_INTERVAL_MS: '86400000',
    NOTIFICATION_RETENTION_BATCH_SIZE: '1000',
    SUPPORT_SLA_HOURS: '24',
    SUPPORT_AUTO_CLOSE_AFTER_HOURS: '168',
    JOB_SUPPORT_INTERVAL_MS: '60000',
    SUPPORT_JOBS_BATCH_SIZE: '100',
    // Web Push (spec 13 §8.6); tests swap the sender for a fake through DI
    VAPID_PUBLIC_KEY: TEST_VAPID_KEYS.publicKey,
    VAPID_PRIVATE_KEY: TEST_VAPID_KEYS.privateKey,
    VAPID_SUBJECT: 'mailto:test@nile.test',
    PUSH_HTTP_TIMEOUT_MS: '2000',
    PUSH_ENDPOINT_HOST_ALLOWLIST:
      'fcm.googleapis.com,updates.push.services.mozilla.com,*.notify.windows.com,web.push.apple.com',
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
    // catalog
    CATEGORY_TREE_CACHE_TTL_SECONDS: '3600',
    PRODUCT_DETAIL_CACHE_TTL_SECONDS: '60',
    SEARCH_WORD_SIMILARITY_THRESHOLD: '0.35',
    // cart
    CART_MAX_LINES: '50',
    // ordering
    SELLER_ACCEPT_TIMEOUT_HOURS: '24',
    JOB_SELLER_ACCEPTANCE_TIMEOUT_INTERVAL_MS: '60000',
    JOB_KASHIER_PAYMENT_EXPIRY_INTERVAL_MS: '30000',
    KASHIER_PAYMENT_TTL_MINUTES: '15',
    ORDER_JOBS_BATCH_SIZE: '100',
    JOB_SHIPMENT_ASSIGNMENT_RETRY_INTERVAL_MS: '60000',
    SHIPMENT_JOBS_BATCH_SIZE: '100',
    // audit retention (worker, spec 20 §2.4)
    AUDIT_RETENTION_DAYS: '730',
    JOB_AUDIT_RETENTION_INTERVAL_MS: '86400000',
    AUDIT_RETENTION_BATCH_SIZE: '1000',
    // Object storage (spec 14 §6; STORAGE_PROVIDER, _BUCKET, _REGION are derived in AWS)
    STORAGE_HTTP_TIMEOUT_MS: '5000',
    // Per test file: createTestResources points these at the file's own MinIO bucket.
    STORAGE_PROVIDER: 'minio',
    STORAGE_BUCKET: 'test-media',
    STORAGE_REGION: 'us-east-1',
    STORAGE_ENDPOINT: 'http://localhost:9000',
    STORAGE_PUBLIC_ENDPOINT: 'http://localhost:9000',
    STORAGE_ACCESS_KEY_ID: 'minioadmin',
    STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
    // Media uploads (spec 14 §1, §6)
    MEDIA_PUBLIC_BASE_URL: 'http://localhost:9000/test-media',
    MEDIA_MAX_UPLOAD_BYTES: '5242880',
    MEDIA_UPLOAD_URL_TTL_SECONDS: '300',
    MEDIA_PRIVATE_URL_TTL_SECONDS: '600',
    MEDIA_MAX_OPEN_UPLOADS_PER_USER: '20',
    SUPPORT_MAX_OPEN_TICKETS_PER_USER: '20',
    REVIEW_WINDOW_DAYS: '60',
    REVIEW_EDIT_WINDOW_DAYS: '30',
    // Media cleanup job (spec 14 UC-ME-4)
    MEDIA_PENDING_RETENTION_HOURS: '24',
    JOB_MEDIA_CLEANUP_INTERVAL_MS: '3600000',
    MEDIA_CLEANUP_BATCH_SIZE: '100',
    // payments: the fake gateway, signing webhooks with TEST_KASHIER_API_KEY
    PAYMENT_GATEWAY: 'fake',
    KASHIER_API_KEY: TEST_KASHIER_API_KEY,
    KASHIER_HTTP_TIMEOUT_MS: '2000',
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
