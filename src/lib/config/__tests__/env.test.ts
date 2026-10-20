import { describe, expect, it } from 'vitest';
import { testEnvInput, TEST_JWT_PRIVATE_KEY_PEM } from '../../../../test/helpers/test-env';
import {
  apiEnvSchema,
  EnvValidationError,
  loadEnv,
  migrateEnvSchema,
  seedAdminEnvSchema,
  workerEnvSchema,
} from '..';

function invalidKeys(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return (error as EnvValidationError).invalidKeys.map((issue) => issue.key).sort();
  }
  throw new Error('expected loadEnv to throw');
}

describe('lib/config per-process env schemas (P1-Q1)', () => {
  it('api: parses and coerces', () => {
    const env = loadEnv(
      apiEnvSchema,
      testEnvInput({ CORS_ALLOWED_ORIGINS: 'https://a.example, https://b.example' }),
    );
    expect(env.PORT).toBe(3000);
    expect(env.DB_SSL).toBe(false);
    expect(env.API_DOCS_ENABLED).toBe(true);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
    expect(Object.keys(env.JWT_PUBLIC_KEYS)).toEqual(['test-k1']);
    expect(env.SECRETS_ENCRYPTION_KEYS['test-s1']).toHaveLength(32);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('api: an empty CORS allow-list is valid (mobile-only clients)', () => {
    expect(loadEnv(apiEnvSchema, testEnvInput({ CORS_ALLOWED_ORIGINS: '' })).CORS_ALLOWED_ORIGINS).toEqual(
      [],
    );
  });

  it('worker: parses, including the email provider settings', () => {
    const env = loadEnv(workerEnvSchema, testEnvInput());
    expect(env.MQ_RETRY_DELAYS_MS).toEqual([100, 200]);
    expect(env.EMAIL_PROVIDER).toBe('mailpit');
  });

  it('each process receives only its own keys (secrets are not shared)', () => {
    const input = testEnvInput({ EMAIL_PROVIDER: 'mailjet', MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's' });
    const worker: object = loadEnv(workerEnvSchema, input);
    const api: object = loadEnv(apiEnvSchema, input);
    const migrate: object = loadEnv(migrateEnvSchema, input);
    expect(worker).not.toHaveProperty('JWT_PRIVATE_KEY');
    expect(worker).not.toHaveProperty('REDIS_URL');
    expect(api).not.toHaveProperty('MAILJET_SECRET_KEY');
    expect(api).not.toHaveProperty('MAILJET_API_KEY');
    expect(Object.keys(migrate).sort()).toEqual(
      [
        'DATABASE_URL',
        'DB_POOL_MAX',
        'DB_POOL_MIN',
        'DB_SSL',
        'DB_STATEMENT_TIMEOUT_MS',
        'HEALTH_CHECK_TIMEOUT_MS',
        'LOG_LEVEL',
        'NODE_ENV',
        'SERVICE_NAME',
        'SHUTDOWN_TIMEOUT_MS',
      ].sort(),
    );
  });

  it('migrate needs only common + database keys; seed-admin also needs invite + secrets keys', () => {
    const input = testEnvInput();
    const keys = [
      'NODE_ENV',
      'SERVICE_NAME',
      'LOG_LEVEL',
      'SHUTDOWN_TIMEOUT_MS',
      'HEALTH_CHECK_TIMEOUT_MS',
      'DATABASE_URL',
      'DB_SSL',
      'DB_POOL_MIN',
      'DB_POOL_MAX',
      'DB_STATEMENT_TIMEOUT_MS',
    ];
    const minimal = Object.fromEntries(keys.map((key) => [key, input[key]]));
    expect(() => loadEnv(migrateEnvSchema, minimal)).not.toThrow();
    expect(invalidKeys(() => loadEnv(seedAdminEnvSchema, minimal))).toEqual([
      'INVITE_TTL_HOURS',
      'INVITE_URL_BASE',
      'SECRETS_ENCRYPTION_ACTIVE_KEY_ID',
      'SECRETS_ENCRYPTION_KEYS',
    ]);
  });

  it('has no defaults: a missing key fails', () => {
    const input = testEnvInput();
    delete input.REDIS_URL;
    expect(invalidKeys(() => loadEnv(apiEnvSchema, input))).toEqual(['REDIS_URL']);
  });

  it('reports every bad key by name and never includes values', () => {
    const secretLookingValue = 'postgres-password-should-not-leak';
    try {
      loadEnv(
        apiEnvSchema,
        testEnvInput({ PORT: 'abc', DATABASE_URL: secretLookingValue, LOG_LEVEL: 'verbose' }),
      );
      expect.unreachable();
    } catch (error) {
      const envError = error as EnvValidationError;
      expect(envError.invalidKeys.map((issue) => issue.key).sort()).toEqual([
        'DATABASE_URL',
        'LOG_LEVEL',
        'PORT',
      ]);
      expect(JSON.stringify(envError.invalidKeys)).not.toContain(secretLookingValue);
      expect(envError.message).not.toContain(secretLookingValue);
    }
  });

  it('rejects malformed booleans, lists, JSON and keys', () => {
    expect(invalidKeys(() => loadEnv(apiEnvSchema, testEnvInput({ DB_SSL: 'yes' })))).toEqual(['DB_SSL']);
    expect(
      invalidKeys(() => loadEnv(workerEnvSchema, testEnvInput({ MQ_RETRY_DELAYS_MS: '100,abc' }))),
    ).toEqual(['MQ_RETRY_DELAYS_MS']);
    expect(invalidKeys(() => loadEnv(apiEnvSchema, testEnvInput({ JWT_PUBLIC_KEYS: '{not json' })))).toEqual([
      'JWT_PUBLIC_KEYS',
    ]);
    expect(invalidKeys(() => loadEnv(apiEnvSchema, testEnvInput({ JWT_PRIVATE_KEY: 'not a pem' })))).toEqual([
      'JWT_PRIVATE_KEY',
    ]);
    const shortKey = JSON.stringify({ 'test-s1': Buffer.alloc(16).toString('base64') });
    expect(
      invalidKeys(() => loadEnv(apiEnvSchema, testEnvInput({ SECRETS_ENCRYPTION_KEYS: shortKey }))),
    ).toEqual(['SECRETS_ENCRYPTION_KEYS']);
  });

  it('accepts a PEM private key written on one line with \\n escapes (env files, secret stores)', () => {
    const oneLine = TEST_JWT_PRIVATE_KEY_PEM.trim().replace(/\n/g, '\\n');
    const env = loadEnv(apiEnvSchema, testEnvInput({ JWT_PRIVATE_KEY: oneLine }));
    expect(env.JWT_PRIVATE_KEY).toBe(TEST_JWT_PRIVATE_KEY_PEM.trim());
  });

  it('checks cross-field rules', () => {
    expect(
      invalidKeys(() => loadEnv(apiEnvSchema, testEnvInput({ PAGINATION_DEFAULT_LIMIT: '200' }))),
    ).toEqual(['PAGINATION_DEFAULT_LIMIT']);
    expect(invalidKeys(() => loadEnv(migrateEnvSchema, testEnvInput({ DB_POOL_MIN: '9' })))).toEqual([
      'DB_POOL_MIN',
    ]);
    expect(invalidKeys(() => loadEnv(apiEnvSchema, testEnvInput({ JWT_ACTIVE_KID: 'unknown' })))).toEqual([
      'JWT_ACTIVE_KID',
    ]);
    expect(
      invalidKeys(() =>
        loadEnv(workerEnvSchema, testEnvInput({ SECRETS_ENCRYPTION_ACTIVE_KEY_ID: 'unknown' })),
      ),
    ).toEqual(['SECRETS_ENCRYPTION_ACTIVE_KEY_ID']);
  });

  it('email provider keys are required per provider; mailpit is refused in staging/production', () => {
    expect(invalidKeys(() => loadEnv(workerEnvSchema, testEnvInput({ EMAIL_PROVIDER: 'mailjet' })))).toEqual([
      'MAILJET_API_KEY',
      'MAILJET_SECRET_KEY',
    ]);
    const noMailpitUrl = testEnvInput();
    delete noMailpitUrl.MAILPIT_URL;
    expect(invalidKeys(() => loadEnv(workerEnvSchema, noMailpitUrl))).toEqual(['MAILPIT_URL']);
    expect(
      invalidKeys(() =>
        loadEnv(
          workerEnvSchema,
          testEnvInput({ NODE_ENV: 'production', DB_SSL: 'true', ...KASHIER_TEST, ...S3_STORAGE }),
        ),
      ),
    ).toEqual(['EMAIL_PROVIDER']);
  });

  it('payments: fake only outside staging/production; kashier needs its keys and a host matching its mode', () => {
    expect(
      invalidKeys(() =>
        loadEnv(apiEnvSchema, testEnvInput({ NODE_ENV: 'staging', DB_SSL: 'true', ...S3_STORAGE })),
      ),
    ).toEqual(['PAYMENT_GATEWAY']);
    // The worker only reads session statuses: no secret key, merchant id or URLs needed (PA-13).
    expect(invalidKeys(() => loadEnv(workerEnvSchema, testEnvInput({ PAYMENT_GATEWAY: 'kashier' })))).toEqual(
      ['KASHIER_BASE_URL', 'KASHIER_MODE'],
    );
    expect(invalidKeys(() => loadEnv(apiEnvSchema, testEnvInput({ PAYMENT_GATEWAY: 'kashier' })))).toEqual([
      'KASHIER_BASE_URL',
      'KASHIER_MERCHANT_ID',
      'KASHIER_MODE',
      'KASHIER_REDIRECT_URL',
      'KASHIER_SECRET_KEY',
      'KASHIER_WEBHOOK_URL',
    ]);
    expect(() => loadEnv(apiEnvSchema, testEnvInput(KASHIER_TEST))).not.toThrow();
    expect(
      invalidKeys(() => loadEnv(apiEnvSchema, testEnvInput({ ...KASHIER_TEST, KASHIER_MODE: 'live' }))),
    ).toEqual(['KASHIER_BASE_URL']);
    expect(
      invalidKeys(() =>
        loadEnv(
          apiEnvSchema,
          testEnvInput({ ...KASHIER_TEST, KASHIER_WEBHOOK_URL: 'http://api.nile.test/x' }),
        ),
      ),
    ).toEqual(['KASHIER_WEBHOOK_URL']);
    expect(invalidKeys(() => loadEnv(apiEnvSchema, testEnvInput({ KASHIER_API_KEY: '' })))).toEqual([
      'KASHIER_API_KEY',
    ]);
  });
});

describe('lib/config deployed-environment guards (P8 security review F-3)', () => {
  const deployed = (nodeEnv: 'staging' | 'production', overrides: Record<string, string> = {}) =>
    testEnvInput({
      NODE_ENV: nodeEnv,
      DB_SSL: 'true',
      API_DOCS_ENABLED: 'false',
      ...KASHIER_TEST,
      ...S3_STORAGE,
      ...overrides,
    });

  it('a deployed configuration with TLS, https links and no docs in production is valid', () => {
    expect(() => loadEnv(apiEnvSchema, deployed('production'))).not.toThrow();
    expect(() => loadEnv(apiEnvSchema, deployed('staging', { API_DOCS_ENABLED: 'true' }))).not.toThrow();
  });

  it('refuses database connections without TLS in staging and production, for every process', () => {
    for (const nodeEnv of ['staging', 'production'] as const) {
      const input = deployed(nodeEnv, { DB_SSL: 'false' });
      expect(invalidKeys(() => loadEnv(apiEnvSchema, input))).toEqual(['DB_SSL']);
      expect(invalidKeys(() => loadEnv(migrateEnvSchema, input))).toEqual(['DB_SSL']);
      expect(invalidKeys(() => loadEnv(seedAdminEnvSchema, input))).toEqual(['DB_SSL']);
    }
    expect(() => loadEnv(apiEnvSchema, testEnvInput({ DB_SSL: 'false' }))).not.toThrow();
  });

  it('refuses the API docs in production and an http invite link once deployed', () => {
    expect(
      invalidKeys(() => loadEnv(apiEnvSchema, deployed('production', { API_DOCS_ENABLED: 'true' }))),
    ).toEqual(['API_DOCS_ENABLED']);
    const httpInvite = { INVITE_URL_BASE: 'http://app.nile.test/invite' };
    expect(invalidKeys(() => loadEnv(apiEnvSchema, deployed('staging', httpInvite)))).toEqual([
      'INVITE_URL_BASE',
    ]);
    expect(invalidKeys(() => loadEnv(seedAdminEnvSchema, deployed('production', httpInvite)))).toEqual([
      'INVITE_URL_BASE',
    ]);
    expect(() => loadEnv(apiEnvSchema, testEnvInput(httpInvite))).not.toThrow();
  });

  it('storage: minio only outside staging/production, with its endpoint and keys; https media URLs once deployed', () => {
    const minio = { STORAGE_PROVIDER: 'minio' };
    expect(invalidKeys(() => loadEnv(apiEnvSchema, deployed('production', minio)))).toEqual([
      'STORAGE_PROVIDER',
    ]);
    expect(invalidKeys(() => loadEnv(workerEnvSchema, deployed('staging', minio)))).toEqual([
      'EMAIL_PROVIDER',
      'STORAGE_PROVIDER',
    ]);
    const bare = testEnvInput();
    for (const key of [
      'STORAGE_ENDPOINT',
      'STORAGE_PUBLIC_ENDPOINT',
      'STORAGE_ACCESS_KEY_ID',
      'STORAGE_SECRET_ACCESS_KEY',
    ]) {
      delete bare[key];
    }
    expect(invalidKeys(() => loadEnv(apiEnvSchema, bare))).toEqual([
      'STORAGE_ACCESS_KEY_ID',
      'STORAGE_ENDPOINT',
      'STORAGE_PUBLIC_ENDPOINT',
      'STORAGE_SECRET_ACCESS_KEY',
    ]);
    // The worker signs nothing for browsers.
    expect(invalidKeys(() => loadEnv(workerEnvSchema, bare))).toEqual([
      'STORAGE_ACCESS_KEY_ID',
      'STORAGE_ENDPOINT',
      'STORAGE_SECRET_ACCESS_KEY',
    ]);
    // S3 signs through the task role: no endpoint or keys.
    expect(() => loadEnv(apiEnvSchema, { ...bare, STORAGE_PROVIDER: 's3' })).not.toThrow();
    expect(
      invalidKeys(() =>
        loadEnv(apiEnvSchema, deployed('staging', { MEDIA_PUBLIC_BASE_URL: 'http://media.nile.test' })),
      ),
    ).toEqual(['MEDIA_PUBLIC_BASE_URL']);
    expect(
      invalidKeys(() =>
        loadEnv(apiEnvSchema, testEnvInput({ MEDIA_PUBLIC_BASE_URL: 'https://media.nile.test/' })),
      ),
    ).toEqual(['MEDIA_PUBLIC_BASE_URL']);
  });
});

/** Storage as deployed: S3 through the task role, images through the CDN. */
const S3_STORAGE = { STORAGE_PROVIDER: 's3', MEDIA_PUBLIC_BASE_URL: 'https://media.nile.test' };

/** A complete Kashier test-environment configuration (placeholder values). */
const KASHIER_TEST = {
  PAYMENT_GATEWAY: 'kashier',
  KASHIER_BASE_URL: 'https://test-api.kashier.io',
  KASHIER_MODE: 'test',
  KASHIER_MERCHANT_ID: 'MID-1-2',
  KASHIER_SECRET_KEY: 'secret$key',
  KASHIER_REDIRECT_URL: 'https://app.nile.test/payment-return',
  KASHIER_WEBHOOK_URL: 'https://api.nile.test/api/v1/webhooks/kashier',
};
