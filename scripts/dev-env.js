'use strict';
// Usage: npm run dev:env
// Creates or COMPLETES a local .env (git-ignored) with development values. Existing keys are never
// changed, so values you set yourself (e.g. Mailjet keys) are kept. Missing keys are appended.
// This is developer tooling, not an application default: the app still requires every key (CLAUDE.md §4).
const fs = require('node:fs');
const path = require('node:path');
const { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } = require('node:crypto');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
const legacyKeyFile = path.join(root, '.dev-keys', 'jwt-dev-private.pem');
const JWT_KID = 'dev1';
const SECRETS_KID = 'dev-s1';

function parseEnv(text) {
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

// The realtime gateway runs next to the api on the same .env, so it overrides the per-process keys
// from this second file (`npm run dev:realtime` passes it after .env; the later file wins).
const realtimeEnvFile = path.join(root, '.env.realtime');
if (!fs.existsSync(realtimeEnvFile)) {
  fs.writeFileSync(realtimeEnvFile, 'PORT=3001\nSERVICE_NAME=nile-realtime\n', { mode: 0o600 });
  console.log('Created .env.realtime (PORT=3001, SERVICE_NAME=nile-realtime)');
}

const existingText = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const existing = parseEnv(existingText);

// Reuse the P0 dev key if present, so the public key already in .env keeps matching.
function devKeyPair() {
  if (fs.existsSync(legacyKeyFile)) {
    const privateKey = createPrivateKey(fs.readFileSync(legacyKeyFile));
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

const values = {
  // common
  NODE_ENV: 'development',
  SERVICE_NAME: 'nile-api',
  LOG_LEVEL: 'debug',
  SHUTDOWN_TIMEOUT_MS: '10000',
  HEALTH_CHECK_TIMEOUT_MS: '2000',
  // database / redis / broker
  DATABASE_URL: 'postgres://nile:nile@localhost:5432/nile',
  DB_SSL: 'false',
  DB_POOL_MIN: '0',
  DB_POOL_MAX: '10',
  DB_STATEMENT_TIMEOUT_MS: '10000',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_KEY_PREFIX: 'nile:dev:',
  RABBITMQ_URL: 'amqp://nile:nile@localhost:5672',
  RABBITMQ_EXCHANGE: 'nile.events',
  RABBITMQ_PREFETCH: '20',
  MQ_RETRY_DELAYS_MS: '5000,30000,300000',
  // jobs
  OUTBOX_DRAIN_INTERVAL_MS: '1000',
  OUTBOX_BATCH_SIZE: '100',
  OUTBOX_MAX_BACKOFF_MS: '300000',
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
  // jwt (filled below when missing)
  JWT_ALGORITHM: 'RS256',
  JWT_ISSUER: 'nile-dev',
  JWT_AUDIENCE: 'nile-app',
  ACCESS_TOKEN_TTL_MINUTES: '15',
  REFRESH_TOKEN_TTL_DAYS: '30',
  // rate limits / idempotency
  RATE_LIMIT_GENERAL_POINTS: '600',
  RATE_LIMIT_GENERAL_WINDOW_SECONDS: '60',
  RATE_LIMIT_STRICT_AUTH_POINTS: '10',
  RATE_LIMIT_STRICT_AUTH_WINDOW_SECONDS: '300',
  RATE_LIMIT_REFRESH_POINTS: '30',
  RATE_LIMIT_REFRESH_WINDOW_SECONDS: '300',
  RATE_LIMIT_CHECKOUT_POINTS: '10',
  RATE_LIMIT_CHECKOUT_WINDOW_SECONDS: '60',
  // Upload rate limit, per user (spec 14 ME-6)
  RATE_LIMIT_UPLOAD_POINTS: '30',
  RATE_LIMIT_UPLOAD_WINDOW_SECONDS: '600',
  // realtime gateway (spec 15 §6, RT-5)
  RATE_LIMIT_REALTIME_CONNECT_POINTS: '60',
  RATE_LIMIT_REALTIME_CONNECT_WINDOW_SECONDS: '60',
  REALTIME_SIGNAL_RATE_PER_SECOND: '5',
  // notification centre retention (spec 13 UC-NO-5, NO-7)
  NOTIFICATION_RETENTION_DAYS: '90',
  JOB_NOTIFICATION_RETENTION_INTERVAL_MS: '86400000',
  NOTIFICATION_RETENTION_BATCH_SIZE: '1000',
  // Web Push (spec 13 §8.6): the push services browsers use (NO-22)
  PUSH_ENDPOINT_HOST_ALLOWLIST:
    'fcm.googleapis.com,updates.push.services.mozilla.com,*.notify.windows.com,web.push.apple.com',
  VAPID_SUBJECT: 'mailto:dev@nile.local',
  PUSH_HTTP_TIMEOUT_MS: '10000',
  IDEMPOTENCY_TTL_HOURS: '24',
  IDEMPOTENCY_LOCK_TTL_SECONDS: '60',
  // identity / invites (P1-Q4)
  BCRYPT_COST: '12',
  OTP_TTL_MINUTES: '10',
  OTP_MAX_ATTEMPTS: '5',
  OTP_RESEND_COOLDOWN_SECONDS: '60',
  INVITE_TTL_HOURS: '72',
  INVITE_URL_BASE: 'http://localhost:3000/invite',
  // customers (spec 04)
  CUSTOMER_MAX_ADDRESSES: '20',
  // delivery reference data (P2-Q5)
  GOVERNORATES_CACHE_TTL_SECONDS: '3600',
  // catalog (P3-Q9)
  CATEGORY_TREE_CACHE_TTL_SECONDS: '3600',
  PRODUCT_DETAIL_CACHE_TTL_SECONDS: '60',
  SEARCH_WORD_SIMILARITY_THRESHOLD: '0.35',
  // cart (P4-Q10)
  CART_MAX_LINES: '50',
  // ordering (P5-Q10)
  SELLER_ACCEPT_TIMEOUT_HOURS: '24',
  JOB_SELLER_ACCEPTANCE_TIMEOUT_INTERVAL_MS: '60000',
  JOB_KASHIER_PAYMENT_EXPIRY_INTERVAL_MS: '30000',
  KASHIER_PAYMENT_TTL_MINUTES: '15',
  ORDER_JOBS_BATCH_SIZE: '100',
  // delivery jobs (P6-Q9)
  JOB_SHIPMENT_ASSIGNMENT_RETRY_INTERVAL_MS: '60000',
  SHIPMENT_JOBS_BATCH_SIZE: '100',
  // audit retention (worker, spec 20 §2.4)
  AUDIT_RETENTION_DAYS: '730',
  JOB_AUDIT_RETENTION_INTERVAL_MS: '86400000',
  AUDIT_RETENTION_BATCH_SIZE: '1000',
  // Object storage (spec 14 §6; STORAGE_PROVIDER, _BUCKET, _REGION are derived in AWS)
  STORAGE_HTTP_TIMEOUT_MS: '5000',
  // docker-compose MinIO; inside compose the api and worker reach it as http://minio:9000.
  STORAGE_PROVIDER: 'minio',
  STORAGE_BUCKET: 'nile-media',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ENDPOINT: 'http://localhost:9100',
  STORAGE_PUBLIC_ENDPOINT: 'http://localhost:9100',
  STORAGE_ACCESS_KEY_ID: 'nile',
  STORAGE_SECRET_ACCESS_KEY: 'nile-minio',
  // Media uploads (spec 14 §1, §6)
  MEDIA_PUBLIC_BASE_URL: 'http://localhost:9100/nile-media',
  MEDIA_MAX_UPLOAD_BYTES: '5242880',
  MEDIA_UPLOAD_URL_TTL_SECONDS: '300',
  MEDIA_PRIVATE_URL_TTL_SECONDS: '600',
  MEDIA_MAX_OPEN_UPLOADS_PER_USER: '20',
  // Media cleanup job (spec 14 UC-ME-4)
  MEDIA_PENDING_RETENTION_HOURS: '24',
  JOB_MEDIA_CLEANUP_INTERVAL_MS: '3600000',
  MEDIA_CLEANUP_BATCH_SIZE: '100',
  // payments (P5-Q9): the fake gateway locally; set PAYMENT_GATEWAY=kashier plus the Kashier keys
  // (test environment) to talk to Kashier. The fake signs webhooks with this key.
  PAYMENT_GATEWAY: 'fake',
  KASHIER_API_KEY: randomBytes(16).toString('hex'),
  KASHIER_HTTP_TIMEOUT_MS: '10000',
  // email: local inbox by default (P1-Q2); switch EMAIL_PROVIDER to mailjet to send real mail
  EMAIL_PROVIDER: 'mailpit',
  EMAIL_HTTP_TIMEOUT_MS: '10000',
  MAILJET_FROM_EMAIL: 'no-reply@nile.local',
  MAILJET_FROM_NAME: 'Nile (dev)',
  MAILPIT_URL: 'http://localhost:8025',
};

if (!existing.has('JWT_PRIVATE_KEY') || !existing.has('JWT_PUBLIC_KEYS')) {
  const { privateKey, publicKey } = devKeyPair();
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
  values.JWT_PRIVATE_KEY = privatePem.replace(/\n/g, '\\n');
  values.JWT_PUBLIC_KEYS = JSON.stringify({
    [JWT_KID]: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  values.JWT_ACTIVE_KID = JWT_KID;
}
// A local VAPID key pair, once (rotating it drops every browser subscription, R2-Q7).
if (!existing.has('VAPID_PUBLIC_KEY') || !existing.has('VAPID_PRIVATE_KEY')) {
  const vapid = require('web-push').generateVAPIDKeys();
  values.VAPID_PUBLIC_KEY = vapid.publicKey;
  values.VAPID_PRIVATE_KEY = vapid.privateKey;
}
if (!existing.has('SECRETS_ENCRYPTION_KEYS')) {
  values.SECRETS_ENCRYPTION_KEYS = JSON.stringify({ [SECRETS_KID]: randomBytes(32).toString('base64') });
  values.SECRETS_ENCRYPTION_ACTIVE_KEY_ID = SECRETS_KID;
}

// JSON values in single quotes: Node's --env-file does not unescape \" inside double quotes.
const format = (key, value) => (value.startsWith('{') ? `${key}='${value}'` : `${key}=${value}`);
const added = Object.entries(values).filter(([key]) => !existing.has(key));

if (added.length === 0) {
  console.log('.env is already complete; nothing changed.');
  process.exit(0);
}
const prefix = existingText.length > 0 && !existingText.endsWith('\n') ? '\n' : '';
fs.writeFileSync(
  envFile,
  `${existingText}${prefix}${added.map(([key, value]) => format(key, value)).join('\n')}\n`,
  { mode: 0o600 },
);
console.log(`${existingText ? 'Completed' : 'Created'} .env: added ${added.map(([key]) => key).join(', ')}`);
