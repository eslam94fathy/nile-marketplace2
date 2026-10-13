import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBody } from '../helpers/http';
import { startTestApp, type TestApp } from '../helpers/test-app';
import { createTestRouter, TEST_ROUTES_PATH } from '../helpers/test-routes';

// testEnvInput: strict-auth = 5 per 60 s.
const STRICT_POINTS = 5;

describe('rate limiting (G18, docs/spec/01-api-conventions.md §7)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({
      envOverrides: { RATE_LIMIT_GENERAL_POINTS: '1000' },
      extraRouters: (infra) => [{ path: TEST_ROUTES_PATH, router: createTestRouter(infra) }],
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const login = (email: string) => request(t.app).post(`${TEST_ROUTES_PATH}/login-like`).send({ email });

  it('strict-auth: the request over the limit gets 429 + Retry-After', async () => {
    for (let i = 0; i < STRICT_POINTS; i += 1) expect((await login(`a${i}@x.io`)).status).toBe(200);
    const res = await login('another@x.io');
    expect(res.status).toBe(429);
    expect(errorBody(res).error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('strict-auth counts the email separately from the IP (case-insensitive)', async () => {
    // Fresh limits: different key prefix → a new app on new resources.
    const fresh = await startTestApp({
      envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '2' },
      extraRouters: (infra) => [{ path: TEST_ROUTES_PATH, router: createTestRouter(infra) }],
    });
    try {
      const post = (email: string) =>
        request(fresh.app).post(`${TEST_ROUTES_PATH}/login-like`).send({ email });
      expect((await post('Victim@x.io')).status).toBe(200);
      expect((await post('victim@x.io')).status).toBe(200);
      // IP counter is now also at 2: both counters block the third call.
      expect((await post('VICTIM@x.io')).status).toBe(429);
    } finally {
      await fresh.close();
    }
  });

  it('Redis down: sensitive classes fail closed (503), general fails open', async () => {
    const fresh = await startTestApp({
      extraRouters: (infra) => [{ path: TEST_ROUTES_PATH, router: createTestRouter(infra) }],
    });
    try {
      fresh.infra.redis.disconnect();
      const strict = await request(fresh.app)
        .post(`${TEST_ROUTES_PATH}/login-like`)
        .send({ email: 'a@x.io' });
      expect([strict.status, errorBody(strict).error.code]).toEqual([503, 'SERVICE_UNAVAILABLE']);
      const general = await request(fresh.app).get(`${TEST_ROUTES_PATH}/general-limited`);
      expect(general.status).toBe(200);
    } finally {
      await fresh.close();
    }
  });
});
