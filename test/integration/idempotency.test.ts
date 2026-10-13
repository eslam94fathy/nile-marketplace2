import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBody, successBody } from '../helpers/http';
import { signTestAccessToken } from '../helpers/jwt';
import { startTestApp, type TestApp } from '../helpers/test-app';
import { createTestRouter, TEST_ROUTES_PATH } from '../helpers/test-routes';

describe('idempotency (G25, CLAUDE.md §10)', () => {
  let t: TestApp;
  let token: string;

  beforeAll(async () => {
    t = await startTestApp({
      extraRouters: (infra) => [{ path: TEST_ROUTES_PATH, router: createTestRouter(infra) }],
    });
    token = await signTestAccessToken({ role: 'customer' });
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, key: string | undefined, body: object, bearer = token) => {
    const req = request(t.app).post(`${TEST_ROUTES_PATH}${path}`).set('Authorization', `Bearer ${bearer}`);
    return (key ? req.set('Idempotency-Key', key) : req).send(body);
  };
  const executions = async () =>
    successBody<{ executions: number }>(await request(t.app).get(`${TEST_ROUTES_PATH}/executions`)).data
      .executions;

  it('requires a UUID Idempotency-Key', async () => {
    for (const key of [undefined, 'abc']) {
      const res = await post('/orders', key, { item: 1 });
      expect([res.status, errorBody(res).error.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    }
  });

  it('replays the stored status and body for a completed duplicate, without re-executing', async () => {
    const key = randomUUID();
    const first = await post('/orders', key, { item: 1, note: 'a' });
    expect(first.status).toBe(201);
    const before = await executions();

    // Same request, keys in a different order: same fingerprint.
    const replay = await post('/orders', key, { note: 'a', item: 1 });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(await executions()).toBe(before);
  });

  it('same key with a different payload → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const key = randomUUID();
    expect((await post('/orders', key, { item: 1 })).status).toBe(201);
    const res = await post('/orders', key, { item: 2 });
    expect([res.status, errorBody(res).error.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
  });

  it('keys are scoped per user: another user with the same key executes normally', async () => {
    const key = randomUUID();
    expect((await post('/orders', key, { item: 1 })).status).toBe(201);
    const otherUser = await signTestAccessToken({ role: 'customer' });
    const res = await post('/orders', key, { item: 1 }, otherUser);
    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('a concurrent duplicate gets 409 IDEMPOTENCY_REQUEST_IN_PROGRESS', async () => {
    const key = randomUUID();
    // supertest only sends on then(): start the slow request now, so it really is in flight.
    const slow = post('/orders', key, { item: 1, delayMs: 300 }).then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const duplicate = await post('/orders', key, { item: 1, delayMs: 300 });
    expect([duplicate.status, errorBody(duplicate).error.code]).toEqual([
      409,
      'IDEMPOTENCY_REQUEST_IN_PROGRESS',
    ]);
    expect((await slow).status).toBe(201);
  });

  it('5xx is not stored: the retry with the same key executes again', async () => {
    const key = randomUUID();
    const before = await executions();
    expect((await post('/orders-fail', key, { item: 1 })).status).toBe(500);
    expect((await post('/orders-fail', key, { item: 1 })).status).toBe(500);
    expect(await executions()).toBe(before + 2);
  });

  it('4xx responses are stored and replayed too', async () => {
    const key = randomUUID();
    const invalid = await post('/orders-validated', key, { name: '' });
    expect([invalid.status, errorBody(invalid).error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const before = await executions();
    const replay = await post('/orders-validated', key, { name: '' });
    expect(replay.status).toBe(400);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(invalid.body);
    expect(await executions()).toBe(before);
  });

  it('204 responses are replayed without a body', async () => {
    const key = randomUUID();
    expect((await post('/orders-empty', key, {})).status).toBe(204);
    const before = await executions();
    const replay = await post('/orders-empty', key, {});
    expect(replay.status).toBe(204);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await executions()).toBe(before);
  });
});
