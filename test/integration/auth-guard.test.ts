import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBody, successBody } from '../helpers/http';
import { signTestAccessToken } from '../helpers/jwt';
import { startTestApp, type TestApp } from '../helpers/test-app';
import { createTestRouter, TEST_ROUTES_PATH } from '../helpers/test-routes';

const URL = `${TEST_ROUTES_PATH}/admin-only`;

describe('auth guard: Bearer JWT (RS256, pinned) + role guard (CLAUDE.md §10)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({
      extraRouters: (infra) => [{ path: TEST_ROUTES_PATH, router: createTestRouter(infra) }],
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const call = (authorization?: string) => {
    const req = request(t.app).get(URL);
    return authorization === undefined ? req : req.set('Authorization', authorization);
  };

  it('accepts a valid admin token and exposes the user id', async () => {
    const sub = randomUUID();
    const res = await call(`Bearer ${await signTestAccessToken({ sub, role: 'admin' })}`);
    expect(res.status).toBe(200);
    expect(successBody(res).data).toEqual({ userId: sub, role: 'admin' });
  });

  it('wrong role → 403 FORBIDDEN', async () => {
    const res = await call(`Bearer ${await signTestAccessToken({ role: 'customer' })}`);
    expect([res.status, errorBody(res).error.code]).toEqual([403, 'FORBIDDEN']);
  });

  it.each([
    ['missing header', undefined],
    ['not a bearer token', 'Basic abc'],
    ['garbage token', 'Bearer not.a.jwt'],
  ])('%s → 401 UNAUTHENTICATED', async (_name, header) => {
    const res = await call(header);
    expect([res.status, errorBody(res).error.code]).toEqual([401, 'UNAUTHENTICATED']);
  });

  it.each([
    ['expired', { expiresInSeconds: -10 }],
    ['wrong audience', { audience: 'someone-else' }],
    ['wrong issuer', { issuer: 'evil' }],
    ['unknown kid', { kid: 'unknown-kid' }],
    ['unknown role', { role: 'superuser' }],
    ['sub is not a uuid', { sub: 'admin' }],
  ])('%s → 401', async (_name, options) => {
    const res = await call(`Bearer ${await signTestAccessToken({ role: 'admin', ...options })}`);
    expect([res.status, errorBody(res).error.code]).toEqual([401, 'UNAUTHENTICATED']);
  });

  it('a token signed with another algorithm (HS256) is rejected even with a known kid', async () => {
    const forged = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256', kid: 'test-k1' })
      .setSubject(randomUUID())
      .setIssuer('nile-test')
      .setAudience('nile-test-app')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-guessable-shared-secret-of-sufficient-length'));
    const res = await call(`Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});
