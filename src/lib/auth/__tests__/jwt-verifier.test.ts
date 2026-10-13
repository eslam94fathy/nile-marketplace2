import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { testEnvInput } from '../../../../test/helpers/test-env';
import { apiEnvSchema, loadEnv } from '../../config';
import { JwtSigner, JwtVerifier, SuspendedUsers } from '..';

const env = loadEnv(apiEnvSchema, testEnvInput());

async function tokenFor(userId: string): Promise<string> {
  const signer = await JwtSigner.create(env, { now: () => new Date() });
  return (await signer.signAccessToken({ userId, role: 'customer' })).token;
}

/* Spec 03 I-11 (security review F-4): a suspended user's still-valid tokens are refused. */
describe('lib/auth JwtVerifier block check', () => {
  it('refuses a valid token of a blocked user and accepts the others', async () => {
    const blockedId = randomUUID();
    const verifier = await JwtVerifier.create(env, { isBlocked: (id) => Promise.resolve(id === blockedId) });
    await expect(verifier.verify(await tokenFor(blockedId))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const other = randomUUID();
    expect(await verifier.verify(await tokenFor(other))).toEqual({ userId: other, role: 'customer' });
  });

  it('fails open when the check itself fails, and reports it', async () => {
    const onBlockCheckError = vi.fn();
    const verifier = await JwtVerifier.create(env, {
      isBlocked: () => Promise.reject(new Error('redis down')),
      onBlockCheckError,
    });
    const userId = randomUUID();
    expect(await verifier.verify(await tokenFor(userId))).toEqual({ userId, role: 'customer' });
    expect(onBlockCheckError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('never runs the check for a token that fails verification', async () => {
    const isBlocked = vi.fn(() => Promise.resolve(false));
    const verifier = await JwtVerifier.create(env, { isBlocked });
    await expect(verifier.verify('not.a.jwt')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(isBlocked).not.toHaveBeenCalled();
  });
});

describe('lib/auth SuspendedUsers', () => {
  it('blocks with the access-token TTL and unblocks', async () => {
    const store = new Map<string, string>();
    const cache = {
      get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: vi.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => Promise.resolve(store.delete(key) ? 1 : 0)),
      setIfAbsent: vi.fn(),
      ping: vi.fn(),
    };
    const users = new SuspendedUsers(cache, 900);
    await users.block('u-1');
    expect(cache.set).toHaveBeenCalledWith('auth:suspended:u-1', '1', 900);
    expect(await users.isBlocked('u-1')).toBe(true);
    await users.unblock('u-1');
    expect(await users.isBlocked('u-1')).toBe(false);
  });
});
