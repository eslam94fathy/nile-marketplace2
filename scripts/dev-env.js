'use strict';
// Usage: npm run dev:env
// Creates a local .env (git-ignored) with development values and a dev-only JWT key pair.
// This is developer tooling, not an application default: the app still requires every key (CLAUDE.md §4).
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
const keyDir = path.join(root, '.dev-keys');

if (fs.existsSync(envFile)) {
  console.error('.env already exists; delete it first to regenerate.');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.mkdirSync(keyDir, { recursive: true });
fs.writeFileSync(
  path.join(keyDir, 'jwt-dev-private.pem'),
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
  {
    mode: 0o600,
  },
);
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const values = {
  NODE_ENV: 'development',
  SERVICE_NAME: 'nile-api',
  LOG_LEVEL: 'debug',
  PORT: '3000',
  HTTP_BODY_LIMIT_KB: '100',
  TRUST_PROXY_HOPS: '0',
  CORS_ALLOWED_ORIGINS: '',
  SHUTDOWN_TIMEOUT_MS: '10000',
  API_DOCS_ENABLED: 'true',
  HEALTH_CHECK_TIMEOUT_MS: '2000',
  PAGINATION_DEFAULT_LIMIT: '20',
  PAGINATION_MAX_LIMIT: '100',
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
  OUTBOX_DRAIN_INTERVAL_MS: '1000',
  OUTBOX_BATCH_SIZE: '100',
  OUTBOX_MAX_BACKOFF_MS: '300000',
  OUTBOX_RETENTION_DAYS: '7',
  PROCESSED_EVENTS_RETENTION_DAYS: '30',
  CLEANUP_JOB_INTERVAL_MS: '86400000',
  JWT_ALGORITHM: 'RS256',
  JWT_ISSUER: 'nile-dev',
  JWT_AUDIENCE: 'nile-app',
  JWT_PUBLIC_KEYS: JSON.stringify({ dev1: publicPem }),
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
};

// JSON values in single quotes: Node's --env-file does not unescape \" inside double quotes.
const lines = Object.entries(values).map(([key, value]) =>
  value.startsWith('{') ? `${key}='${value}'` : `${key}=${value}`,
);
fs.writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
console.log('Created .env and .dev-keys/jwt-dev-private.pem (kid "dev1"). Both are git-ignored.');
