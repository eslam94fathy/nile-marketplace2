import { z } from 'zod';

/**
 * Environment schema (CLAUDE.md §4). Every key is required and has NO default.
 * Phase 0 holds infrastructure keys only; modules add theirs when they are built.
 */

const integer = (min: number, max: number = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max);
const positiveInt = (max?: number) => integer(1, max);

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

/** `"a, b,c"` → `['a', 'b', 'c']`; an empty string → `[]`. Pipe into the item schema. */
const commaList = z.string().transform((raw) =>
  raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0),
);

/** JSON object string, e.g. `{"k1":"-----BEGIN PUBLIC KEY-----\n..."}`. */
const jsonRecord = z
  .string()
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), z.string().min(1)));

export const NodeEnv = {
  DEVELOPMENT: 'development',
  TEST: 'test',
  STAGING: 'staging',
  PRODUCTION: 'production',
} as const;
export const LogLevelName = {
  FATAL: 'fatal',
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
} as const;

export const envSchema = z.object({
  NODE_ENV: z.enum([NodeEnv.DEVELOPMENT, NodeEnv.TEST, NodeEnv.STAGING, NodeEnv.PRODUCTION]),
  SERVICE_NAME: z.string().regex(/^[a-z][a-z0-9-]{1,49}$/),
  LOG_LEVEL: z.enum([
    LogLevelName.FATAL,
    LogLevelName.ERROR,
    LogLevelName.WARN,
    LogLevelName.INFO,
    LogLevelName.DEBUG,
  ]),

  // HTTP
  PORT: integer(1, 65_535),
  HTTP_BODY_LIMIT_KB: positiveInt(10_240),
  TRUST_PROXY_HOPS: integer(0, 10),
  CORS_ALLOWED_ORIGINS: commaList.pipe(z.array(z.url())),
  SHUTDOWN_TIMEOUT_MS: positiveInt(120_000),
  API_DOCS_ENABLED: booleanString,
  HEALTH_CHECK_TIMEOUT_MS: positiveInt(30_000),

  // Lists (CLAUDE.md §8)
  PAGINATION_DEFAULT_LIMIT: positiveInt(1_000),
  PAGINATION_MAX_LIMIT: positiveInt(1_000),

  // PostgreSQL
  DATABASE_URL: z.url().refine((url) => /^postgres(ql)?:\/\//.test(url), 'must be a postgres:// URL'),
  DB_SSL: booleanString,
  DB_POOL_MIN: integer(0, 100),
  DB_POOL_MAX: positiveInt(100),
  DB_STATEMENT_TIMEOUT_MS: positiveInt(600_000),

  // Redis
  REDIS_URL: z.url().refine((url) => /^rediss?:\/\//.test(url), 'must be a redis:// or rediss:// URL'),
  REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9:_-]{1,50}$/),

  // RabbitMQ
  RABBITMQ_URL: z.url().refine((url) => /^amqps?:\/\//.test(url), 'must be an amqp:// or amqps:// URL'),
  RABBITMQ_EXCHANGE: z.string().regex(/^[a-z0-9._-]{1,100}$/),
  RABBITMQ_PREFETCH: positiveInt(1_000),
  MQ_RETRY_DELAYS_MS: commaList.pipe(z.array(z.coerce.number<string>().int().positive()).min(1).max(10)),

  // Outbox, consumers and cleanup jobs (architecture §5–§6, DB-Q5)
  OUTBOX_DRAIN_INTERVAL_MS: positiveInt(60_000),
  OUTBOX_BATCH_SIZE: positiveInt(1_000),
  OUTBOX_MAX_BACKOFF_MS: positiveInt(3_600_000),
  OUTBOX_RETENTION_DAYS: positiveInt(365),
  PROCESSED_EVENTS_RETENTION_DAYS: positiveInt(365),
  CLEANUP_JOB_INTERVAL_MS: positiveInt(86_400_000),

  // Auth (verification only in Phase 0; signing keys come with identity)
  JWT_ALGORITHM: z.enum(['RS256']),
  JWT_ISSUER: z.string().min(1).max(200),
  JWT_AUDIENCE: z.string().min(1).max(200),
  JWT_PUBLIC_KEYS: jsonRecord,

  // Rate-limit classes (docs/spec/01-api-conventions.md §7)
  RATE_LIMIT_GENERAL_POINTS: positiveInt(),
  RATE_LIMIT_GENERAL_WINDOW_SECONDS: positiveInt(),
  RATE_LIMIT_STRICT_AUTH_POINTS: positiveInt(),
  RATE_LIMIT_STRICT_AUTH_WINDOW_SECONDS: positiveInt(),
  RATE_LIMIT_REFRESH_POINTS: positiveInt(),
  RATE_LIMIT_REFRESH_WINDOW_SECONDS: positiveInt(),
  RATE_LIMIT_CHECKOUT_POINTS: positiveInt(),
  RATE_LIMIT_CHECKOUT_WINDOW_SECONDS: positiveInt(),

  // Idempotency (CLAUDE.md §10)
  IDEMPOTENCY_TTL_HOURS: positiveInt(24 * 30),
  IDEMPOTENCY_LOCK_TTL_SECONDS: positiveInt(600),
});

export type EnvInput = z.input<typeof envSchema>;
export type Env = z.output<typeof envSchema>;
