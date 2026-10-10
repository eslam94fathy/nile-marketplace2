import { z } from 'zod';

/**
 * Environment schemas (CLAUDE.md §4). Every key is required and has NO default.
 * One schema per process (P1-Q1), so each process only receives the secrets it needs:
 * the JWT private key exists only in the api, email-provider keys only in the worker.
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

const KEY_ID = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);

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
  .pipe(z.record(KEY_ID, z.string().min(1)));

/** PEM given on one line with literal `\n` escapes (env files and secret stores keep it single-line). */
const pemPrivateKey = z
  .string()
  .transform((raw) => raw.replace(/\\n/g, '\n').trim())
  .refine((pem) => /^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/.test(pem), {
    message: 'must be a PKCS#8 PEM private key',
  });

/** `{"k1":"<base64 32 bytes>"}` → key ring of 32-byte Buffers (AES-256-GCM, docs/spec/02-events.md §3.1). */
const aesKeyRing = jsonRecord.transform((record, ctx) => {
  const ring: Record<string, Buffer> = {};
  for (const [kid, base64] of Object.entries(record)) {
    const key = Buffer.from(base64, 'base64');
    if (key.length !== 32) {
      ctx.addIssue({ code: 'custom', message: `key "${kid}" must be 32 bytes, base64-encoded` });
      return z.NEVER;
    }
    ring[kid] = key;
  }
  return ring;
});

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
export const EmailProvider = { MAILJET: 'mailjet', MAILPIT: 'mailpit' } as const;

// ---------------------------------------------------------------------------------------------
// Sections (plain shapes, combined per process below)
// ---------------------------------------------------------------------------------------------

const commonShape = {
  NODE_ENV: z.enum([NodeEnv.DEVELOPMENT, NodeEnv.TEST, NodeEnv.STAGING, NodeEnv.PRODUCTION]),
  SERVICE_NAME: z.string().regex(/^[a-z][a-z0-9-]{1,49}$/),
  LOG_LEVEL: z.enum([
    LogLevelName.FATAL,
    LogLevelName.ERROR,
    LogLevelName.WARN,
    LogLevelName.INFO,
    LogLevelName.DEBUG,
  ]),
  SHUTDOWN_TIMEOUT_MS: positiveInt(120_000),
  HEALTH_CHECK_TIMEOUT_MS: positiveInt(30_000),
};

const databaseShape = {
  DATABASE_URL: z.url().refine((url) => /^postgres(ql)?:\/\//.test(url), 'must be a postgres:// URL'),
  DB_SSL: booleanString,
  DB_POOL_MIN: integer(0, 100),
  DB_POOL_MAX: positiveInt(100),
  DB_STATEMENT_TIMEOUT_MS: positiveInt(600_000),
};

const redisShape = {
  REDIS_URL: z.url().refine((url) => /^rediss?:\/\//.test(url), 'must be a redis:// or rediss:// URL'),
  REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9:_-]{1,50}$/),
};

const brokerConnectionShape = {
  RABBITMQ_URL: z.url().refine((url) => /^amqps?:\/\//.test(url), 'must be an amqp:// or amqps:// URL'),
};

const messagingShape = {
  RABBITMQ_EXCHANGE: z.string().regex(/^[a-z0-9._-]{1,100}$/),
  RABBITMQ_PREFETCH: positiveInt(1_000),
  MQ_RETRY_DELAYS_MS: commaList.pipe(z.array(z.coerce.number<string>().int().positive()).min(1).max(10)),
};

/** Outbox, consumers and cleanup jobs (architecture §5–§6, DB-Q5). */
const jobsShape = {
  OUTBOX_DRAIN_INTERVAL_MS: positiveInt(60_000),
  OUTBOX_BATCH_SIZE: positiveInt(1_000),
  OUTBOX_MAX_BACKOFF_MS: positiveInt(3_600_000),
  OUTBOX_RETENTION_DAYS: positiveInt(365),
  PROCESSED_EVENTS_RETENTION_DAYS: positiveInt(365),
  CODES_RETENTION_DAYS: positiveInt(365),
  CLEANUP_JOB_INTERVAL_MS: positiveInt(86_400_000),
};

const httpShape = {
  PORT: integer(1, 65_535),
  HTTP_BODY_LIMIT_KB: positiveInt(10_240),
  TRUST_PROXY_HOPS: integer(0, 10),
  CORS_ALLOWED_ORIGINS: commaList.pipe(z.array(z.url())),
  API_DOCS_ENABLED: booleanString,
  PAGINATION_DEFAULT_LIMIT: positiveInt(1_000),
  PAGINATION_MAX_LIMIT: positiveInt(1_000),
};

const jwtVerifyShape = {
  JWT_ALGORITHM: z.enum(['RS256']),
  JWT_ISSUER: z.string().min(1).max(200),
  JWT_AUDIENCE: z.string().min(1).max(200),
  JWT_PUBLIC_KEYS: jsonRecord,
};

/** api only (P1-Q5). */
const jwtSignShape = {
  JWT_PRIVATE_KEY: pemPrivateKey,
  JWT_ACTIVE_KID: KEY_ID,
  ACCESS_TOKEN_TTL_MINUTES: positiveInt(24 * 60),
  REFRESH_TOKEN_TTL_DAYS: positiveInt(365),
};

const rateLimitShape = {
  RATE_LIMIT_GENERAL_POINTS: positiveInt(),
  RATE_LIMIT_GENERAL_WINDOW_SECONDS: positiveInt(),
  RATE_LIMIT_STRICT_AUTH_POINTS: positiveInt(),
  RATE_LIMIT_STRICT_AUTH_WINDOW_SECONDS: positiveInt(),
  RATE_LIMIT_REFRESH_POINTS: positiveInt(),
  RATE_LIMIT_REFRESH_WINDOW_SECONDS: positiveInt(),
  RATE_LIMIT_CHECKOUT_POINTS: positiveInt(),
  RATE_LIMIT_CHECKOUT_WINDOW_SECONDS: positiveInt(),
};

const idempotencyShape = {
  IDEMPOTENCY_TTL_HOURS: positiveInt(24 * 30),
  IDEMPOTENCY_LOCK_TTL_SECONDS: positiveInt(600),
};

/** identity settings (spec 03 §1, P1-Q4). */
const identityShape = {
  BCRYPT_COST: integer(10, 15),
  OTP_TTL_MINUTES: positiveInt(60),
  OTP_MAX_ATTEMPTS: positiveInt(20),
  OTP_RESEND_COOLDOWN_SECONDS: positiveInt(3_600),
};

/** customers (spec 04 §1). */
const customersShape = {
  CUSTOMER_MAX_ADDRESSES: positiveInt(100),
};

/** delivery reference data (spec 11 DE-3, P2-Q5). */
const deliveryShape = {
  GOVERNORATES_CACHE_TTL_SECONDS: positiveInt(86_400),
};

/** catalog (spec 06 CA-8, P3-Q9). */
const catalogShape = {
  CATEGORY_TREE_CACHE_TTL_SECONDS: positiveInt(86_400),
  PRODUCT_DETAIL_CACHE_TTL_SECONDS: positiveInt(3_600),
  /** pg_trgm word_similarity threshold for typo-tolerant product search, 0 < t < 1 (P3-O1). */
  SEARCH_WORD_SIMILARITY_THRESHOLD: z.coerce.number().gt(0).lt(1),
};

/** Invites are also created by the seed-admin CLI. */
const inviteShape = {
  INVITE_TTL_HOURS: positiveInt(24 * 30),
  INVITE_URL_BASE: z.url().refine((url) => /^https?:\/\//.test(url), 'must be an http(s) URL'),
};

/** AES-256-GCM key ring for secrets in event payloads (S-1). api encrypts, worker decrypts. */
const secretsShape = {
  SECRETS_ENCRYPTION_KEYS: aesKeyRing,
  SECRETS_ENCRYPTION_ACTIVE_KEY_ID: KEY_ID,
};

/** worker only (P1-Q1, P1-Q2). Provider-specific keys are checked in `refineEmail`. */
const emailShape = {
  EMAIL_PROVIDER: z.enum([EmailProvider.MAILJET, EmailProvider.MAILPIT]),
  EMAIL_HTTP_TIMEOUT_MS: positiveInt(60_000),
  MAILJET_FROM_EMAIL: z.email().max(254),
  MAILJET_FROM_NAME: z.string().min(1).max(100),
  MAILJET_API_KEY: z.string().min(1).optional(),
  MAILJET_SECRET_KEY: z.string().min(1).optional(),
  MAILPIT_URL: z.url().optional(),
};

// ---------------------------------------------------------------------------------------------
// Cross-field rules
// ---------------------------------------------------------------------------------------------

type Ctx = z.core.$RefinementCtx;
const issue = (ctx: Ctx, key: string, message: string) =>
  ctx.addIssue({ code: 'custom', path: [key], message });

function refinePool(env: { DB_POOL_MIN: number; DB_POOL_MAX: number }, ctx: Ctx): void {
  if (env.DB_POOL_MIN > env.DB_POOL_MAX) issue(ctx, 'DB_POOL_MIN', 'must be <= DB_POOL_MAX');
}

function refineSecrets(
  env: { SECRETS_ENCRYPTION_KEYS: Record<string, Buffer>; SECRETS_ENCRYPTION_ACTIVE_KEY_ID: string },
  ctx: Ctx,
): void {
  if (!(env.SECRETS_ENCRYPTION_ACTIVE_KEY_ID in env.SECRETS_ENCRYPTION_KEYS)) {
    issue(ctx, 'SECRETS_ENCRYPTION_ACTIVE_KEY_ID', 'must name a key in SECRETS_ENCRYPTION_KEYS');
  }
}

function refineEmail(env: z.output<z.ZodObject<typeof emailShape>> & { NODE_ENV: string }, ctx: Ctx): void {
  if (env.EMAIL_PROVIDER === EmailProvider.MAILJET) {
    if (!env.MAILJET_API_KEY) issue(ctx, 'MAILJET_API_KEY', 'required when EMAIL_PROVIDER=mailjet');
    if (!env.MAILJET_SECRET_KEY) issue(ctx, 'MAILJET_SECRET_KEY', 'required when EMAIL_PROVIDER=mailjet');
  } else {
    if (!env.MAILPIT_URL) issue(ctx, 'MAILPIT_URL', 'required when EMAIL_PROVIDER=mailpit');
    if (env.NODE_ENV === NodeEnv.STAGING || env.NODE_ENV === NodeEnv.PRODUCTION) {
      issue(ctx, 'EMAIL_PROVIDER', 'mailpit is for development and tests only');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Per-process schemas
// ---------------------------------------------------------------------------------------------

export const migrateEnvSchema = z.object({ ...commonShape, ...databaseShape }).superRefine(refinePool);

/** The first-admin CLI writes an invite + its email event (P1-Q7). */
export const seedAdminEnvSchema = z
  .object({ ...commonShape, ...databaseShape, ...inviteShape, ...secretsShape })
  .superRefine((env, ctx) => {
    refinePool(env, ctx);
    refineSecrets(env, ctx);
  });

export const apiEnvSchema = z
  .object({
    ...commonShape,
    ...databaseShape,
    ...redisShape,
    ...brokerConnectionShape,
    ...httpShape,
    ...jwtVerifyShape,
    ...jwtSignShape,
    ...rateLimitShape,
    ...idempotencyShape,
    ...identityShape,
    ...customersShape,
    ...deliveryShape,
    ...catalogShape,
    ...inviteShape,
    ...secretsShape,
  })
  .superRefine((env, ctx) => {
    refinePool(env, ctx);
    refineSecrets(env, ctx);
    if (env.PAGINATION_DEFAULT_LIMIT > env.PAGINATION_MAX_LIMIT) {
      issue(ctx, 'PAGINATION_DEFAULT_LIMIT', 'must be <= PAGINATION_MAX_LIMIT');
    }
    if (!(env.JWT_ACTIVE_KID in env.JWT_PUBLIC_KEYS)) {
      issue(ctx, 'JWT_ACTIVE_KID', 'must name a key in JWT_PUBLIC_KEYS');
    }
  });

export const workerEnvSchema = z
  .object({
    ...commonShape,
    ...databaseShape,
    ...brokerConnectionShape,
    ...messagingShape,
    ...jobsShape,
    ...secretsShape,
    ...emailShape,
  })
  .superRefine((env, ctx) => {
    refinePool(env, ctx);
    refineSecrets(env, ctx);
    refineEmail(env, ctx);
  });

export type MigrateEnv = z.output<typeof migrateEnvSchema>;
export type SeedAdminEnv = z.output<typeof seedAdminEnvSchema>;
export type ApiEnv = z.output<typeof apiEnvSchema>;
export type WorkerEnv = z.output<typeof workerEnvSchema>;

/** Every key of every process: components declare what they need with `Pick<Env, …>`. */
export type Env = ApiEnv & WorkerEnv & SeedAdminEnv & MigrateEnv;
