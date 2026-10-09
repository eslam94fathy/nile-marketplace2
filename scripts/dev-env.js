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
  IDEMPOTENCY_TTL_HOURS: '24',
  IDEMPOTENCY_LOCK_TTL_SECONDS: '60',
  // identity / invites (P1-Q4)
  BCRYPT_COST: '12',
  OTP_TTL_MINUTES: '10',
  OTP_MAX_ATTEMPTS: '5',
  OTP_RESEND_COOLDOWN_SECONDS: '60',
  INVITE_TTL_HOURS: '72',
  INVITE_URL_BASE: 'http://localhost:3000/invite',
  // delivery reference data (P2-Q5)
  GOVERNORATES_CACHE_TTL_SECONDS: '3600',
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
