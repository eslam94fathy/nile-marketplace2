import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/test-app';

describe('API docs (P0-Q4)', () => {
  let enabled: TestApp;
  let disabled: TestApp;

  beforeAll(async () => {
    [enabled, disabled] = await Promise.all([
      startTestApp({ envOverrides: { API_DOCS_ENABLED: 'true' } }),
      startTestApp({ envOverrides: { API_DOCS_ENABLED: 'false' } }),
    ]);
  });
  afterAll(async () => {
    await Promise.all([enabled.close(), disabled.close()]);
  });

  it('serves a valid OpenAPI 3.1 document that includes the health endpoints', async () => {
    const res = await request(enabled.app).get('/api/v1/docs/openapi.json');
    expect(res.status).toBe(200);
    const doc = res.body as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/health/live', '/health/ready']));
    expect(doc.components.schemas).toHaveProperty('ErrorEnvelope');
  });

  it('serves Swagger UI', async () => {
    const res = await request(enabled.app).get('/api/v1/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });

  it('is not mounted when API_DOCS_ENABLED=false (production)', async () => {
    expect((await request(disabled.app).get('/api/v1/docs/openapi.json')).status).toBe(404);
    expect((await request(disabled.app).get('/api/v1/docs/')).status).toBe(404);
  });
});
