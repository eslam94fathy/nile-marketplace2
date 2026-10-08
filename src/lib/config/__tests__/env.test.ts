import { describe, expect, it } from 'vitest';
import { testEnvInput } from '../../../../test/helpers/test-env';
import { EnvValidationError, loadEnv } from '..';

describe('lib/config loadEnv', () => {
  it('parses and coerces a valid environment', () => {
    const env = loadEnv(testEnvInput({ CORS_ALLOWED_ORIGINS: 'https://a.example, https://b.example' }));
    expect(env.PORT).toBe(3000);
    expect(env.DB_SSL).toBe(false);
    expect(env.API_DOCS_ENABLED).toBe(true);
    expect(env.MQ_RETRY_DELAYS_MS).toEqual([100, 200]);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
    expect(Object.keys(env.JWT_PUBLIC_KEYS)).toEqual(['test-k1']);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('accepts an empty CORS allow-list (mobile-only clients)', () => {
    expect(loadEnv(testEnvInput({ CORS_ALLOWED_ORIGINS: '' })).CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('has no defaults: a missing key fails', () => {
    const input = testEnvInput();
    delete input.REDIS_URL;
    expect(() => loadEnv(input)).toThrow(EnvValidationError);
  });

  it('reports every bad key by name and never includes values', () => {
    const secretLookingValue = 'postgres-password-should-not-leak';
    try {
      loadEnv(testEnvInput({ PORT: 'abc', DATABASE_URL: secretLookingValue, LOG_LEVEL: 'verbose' }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
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

  it('rejects malformed booleans, lists, and JSON', () => {
    expect(() => loadEnv(testEnvInput({ DB_SSL: 'yes' }))).toThrow(EnvValidationError);
    expect(() => loadEnv(testEnvInput({ MQ_RETRY_DELAYS_MS: '100,abc' }))).toThrow(EnvValidationError);
    expect(() => loadEnv(testEnvInput({ JWT_PUBLIC_KEYS: '{not json' }))).toThrow(EnvValidationError);
  });

  it('checks cross-field rules', () => {
    expect(() => loadEnv(testEnvInput({ PAGINATION_DEFAULT_LIMIT: '200' }))).toThrow(
      /PAGINATION_DEFAULT_LIMIT/,
    );
    expect(() => loadEnv(testEnvInput({ DB_POOL_MIN: '9' }))).toThrow(/DB_POOL_MIN/);
  });
});
