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
    expect(invalidKeys(() => loadEnv(workerEnvSchema, testEnvInput({ NODE_ENV: 'production' })))).toEqual([
      'EMAIL_PROVIDER',
    ]);
  });
});
