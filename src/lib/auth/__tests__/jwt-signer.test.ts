import { randomUUID } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import { testEnvInput } from '../../../../test/helpers/test-env';
import { apiEnvSchema, loadEnv } from '../../config';
import { JwtSigner, JwtVerifier } from '..';

const env = loadEnv(apiEnvSchema, testEnvInput());
const fixedClock = (iso: string) => ({ now: () => new Date(iso) });

describe('lib/auth JwtSigner', () => {
  it('signs tokens the verifier accepts, with role, kid and the configured TTL', async () => {
    const now = new Date();
    const signer = await JwtSigner.create(env, { now: () => now });
    const userId = randomUUID();
    const { token, expiresAt } = await signer.signAccessToken({ userId, role: 'admin' });

    expect(await (await JwtVerifier.create(env)).verify(token)).toEqual({ userId, role: 'admin' });
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'RS256', kid: 'test-k1', typ: 'JWT' });
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({ sub: userId, role: 'admin', iss: 'nile-test', aud: 'nile-test-app' });
    expect(typeof claims.jti).toBe('string');
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(15 * 60);
    expect(expiresAt.getTime()).toBe((claims.exp ?? 0) * 1000);
  });

  it('takes time from the injected clock: a token issued in the past is expired for the verifier', async () => {
    const signer = await JwtSigner.create(env, fixedClock('2020-01-01T00:00:00Z'));
    const { token } = await signer.signAccessToken({ userId: randomUUID(), role: 'customer' });
    await expect((await JwtVerifier.create(env)).verify(token)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('carries no PII: only ids, role and standard claims', async () => {
    const signer = await JwtSigner.create(env, { now: () => new Date() });
    const { token } = await signer.signAccessToken({ userId: randomUUID(), role: 'seller' });
    expect(Object.keys(decodeJwt(token)).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'role', 'sub']);
  });
});
