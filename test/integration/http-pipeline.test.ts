import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBody, successBody } from '../helpers/http';
import { startTestApp, type TestApp } from '../helpers/test-app';
import { createTestRouter, TEST_ROUTES_PATH } from '../helpers/test-routes';

const VALID_ID = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('HTTP pipeline: correlation id, error envelope, validation, security headers', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({
      extraRouters: (infra) => [{ path: TEST_ROUTES_PATH, router: createTestRouter(infra) }],
    });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('correlation id (G26)', () => {
    it('echoes a valid incoming X-Correlation-Id and puts it in every log line of the request', async () => {
      t.logs.clear();
      const res = await request(t.app).get(`${TEST_ROUTES_PATH}/boom`).set('X-Correlation-Id', VALID_ID);
      expect(res.headers['x-correlation-id']).toBe(VALID_ID);
      expect(errorBody(res).correlationId).toBe(VALID_ID);
      const lines = t.logs.entries();
      expect(lines.length).toBeGreaterThanOrEqual(2); // error log + completion log
      for (const line of lines) expect(line.correlationId).toBe(VALID_ID);
    });

    it('replaces an invalid id and generates one when missing: response header = log id', async () => {
      for (const incoming of ['not-a-uuid', undefined]) {
        t.logs.clear();
        const req = request(t.app).get('/health/live');
        const res = await (incoming ? req.set('X-Correlation-Id', incoming) : req);
        const id = res.headers['x-correlation-id'] as string;
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(id).not.toBe(incoming);
        expect(t.logs.entries().find((line) => line.message === 'request completed')?.correlationId).toBe(id);
      }
    });
  });

  describe('error envelope (CLAUDE.md §7, §9.1)', () => {
    it('unknown route → 404 ROUTE_NOT_FOUND', async () => {
      const res = await request(t.app).get('/api/v1/nope');
      expect(res.status).toBe(404);
      expect(errorBody(res)).toMatchObject({ success: false, error: { code: 'ROUTE_NOT_FOUND' } });
    });

    it('unexpected error → generic 500 without stack or internal message, logged at error with the stack', async () => {
      t.logs.clear();
      const res = await request(t.app).get(`${TEST_ROUTES_PATH}/boom`);
      expect(res.status).toBe(500);
      expect(errorBody(res).error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
      expect(res.text).not.toContain('hunter2');
      expect(res.text).not.toContain('at ');
      const errorLog = t.logs.entries().find((line) => line.level === 'error');
      expect(errorLog).toMatchObject({ method: 'GET', route: `${TEST_ROUTES_PATH}/boom`, statusCode: 500 });
      expect(JSON.stringify(errorLog)).toContain('stack');
    });

    it('malformed JSON → 400 MALFORMED_JSON; oversized body → 413', async () => {
      const bad = await request(t.app)
        .post(`${TEST_ROUTES_PATH}/echo`)
        .set('Content-Type', 'application/json')
        .send('{"name":');
      expect([bad.status, errorBody(bad).error.code]).toEqual([400, 'MALFORMED_JSON']);

      const big = await request(t.app)
        .post(`${TEST_ROUTES_PATH}/echo`)
        .send({ name: 'x'.repeat(200 * 1024), quantity: 1 });
      expect([big.status, errorBody(big).error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    });
  });

  describe('DTO validation (G28)', () => {
    it('valid body passes', async () => {
      const res = await request(t.app).post(`${TEST_ROUTES_PATH}/echo`).send({ name: 'nile', quantity: 2 });
      expect(res.status).toBe(200);
      expect(successBody(res).data).toEqual({ name: 'nile', quantity: 2 });
    });

    it('unknown keys, wrong types and ranges → 400 with structured details', async () => {
      const res = await request(t.app)
        .post(`${TEST_ROUTES_PATH}/echo`)
        .send({ name: '', quantity: '2', isAdmin: true });
      expect(res.status).toBe(400);
      const fields = (errorBody(res).error.details ?? []).map((d) => `${d.field}:${d.constraint}`);
      expect(fields).toEqual(
        expect.arrayContaining(['isAdmin:whitelistValidation', 'name:isLength', 'quantity:isInt']),
      );
    });
  });

  describe('security headers (CLAUDE.md §7)', () => {
    it('no x-powered-by, helmet headers present', async () => {
      const res = await request(t.app).get('/health/live');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeDefined();
    });
  });
});
