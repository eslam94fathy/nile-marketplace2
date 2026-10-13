import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBody, successBody } from '../helpers/http';
import { startTestApp, type TestApp } from '../helpers/test-app';

describe('health probes (CLAUDE.md §12)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('GET /health/live is 200 without touching dependencies', async () => {
    const res = await request(t.app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: 'up' } });
  });

  it('GET /health/ready is 200 with every dependency up, and no versions', async () => {
    const res = await request(t.app).get('/health/ready');
    expect(res.status).toBe(200);
    const data = successBody<{
      status: string;
      checks: Record<string, { status: string; durationMs: number }>;
    }>(res).data;
    expect(data.status).toBe('up');
    expect(Object.keys(data.checks).sort()).toEqual(['postgres', 'rabbitmq', 'redis']);
    for (const check of Object.values(data.checks)) {
      expect(check.status).toBe('up');
      expect(Object.keys(check).sort()).toEqual(['durationMs', 'status']);
    }
  });

  it('health probes are not rate limited and do not log at info', async () => {
    t.logs.clear();
    await request(t.app).get('/health/live');
    const completion = t.logs.entries().find((entry) => entry.message === 'request completed');
    expect(completion?.level).toBe('debug');
  });

  it('GET /health/ready is 503 naming the dependency that is down', async () => {
    t.infra.redis.disconnect();
    const res = await request(t.app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(errorBody(res).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(errorBody(res).error.details).toEqual([
      { field: 'redis', constraint: 'available', message: 'redis is down' },
    ]);
    // Liveness is unaffected.
    expect((await request(t.app).get('/health/live')).status).toBe(200);
  });
});
