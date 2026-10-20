import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthTokensDto } from '../../src/app/identity/dto/auth-response.dto';
import { type Env } from '../../src/lib/config';
import { TOKENS } from '../../src/lib/di';
import { errorBody, successBody } from '../helpers/http';
import { API, identityFixtures, NEW_PASSWORD, PASSWORD } from '../helpers/identity';
import { startTestApp, type TestApp } from '../helpers/test-app';

const COOKIE = '__Secure-nile_rt';
const WEB = { 'X-Nile-Client': 'web' };
const APP_ORIGIN = 'https://app.nile.test';

/** The refresh cookie a response sets, with its attributes; undefined when it sets none. */
function refreshCookieOf(res: request.Response) {
  const header = res.headers['set-cookie'] as unknown;
  const lines = Array.isArray(header) ? (header as string[]) : [];
  const line = lines.find((l) => l.startsWith(`${COOKIE}=`));
  if (!line) return undefined;
  const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
  return { value: pair.slice(COOKIE.length + 1), attributes };
}

/*
 * Spec 03 §8 over HTTP: the web client's refresh cookie (opt-in header, CSRF guard, one transport at a
 * time, clearing), CORS with credentials, and the session events in the outbox.
 */
describe('identity: web token transport and session events', () => {
  let t: TestApp;
  let fx: ReturnType<typeof identityFixtures>;
  let ttlSeconds: number;

  const post = (path: string, body: object = {}, headers: Record<string, string> = {}) =>
    request(t.app).post(`${API}${path}`).set(headers).send(body);
  const withCookie = (token: string) => ({ Cookie: `${COOKIE}=${token}` });
  const webLogin = async (email: string) => {
    const res = await post('/auth/login', { email, password: PASSWORD }, WEB);
    expect(res.status).toBe(200);
    const cookie = refreshCookieOf(res);
    if (!cookie) throw new Error('no refresh cookie');
    return { tokens: successBody<AuthTokensDto>(res).data, cookie: cookie.value };
  };
  const outboxOf = async (eventType: string, userId: string) =>
    (
      await t.infra.db
        .knex('events_outbox')
        .where({ event_type: eventType, aggregate_id: userId })
        .select<{ payload: Record<string, unknown> }[]>('payload')
    ).map((row) => row.payload);

  beforeAll(async () => {
    t = await startTestApp({
      envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '10000', CORS_ALLOWED_ORIGINS: APP_ORIGIN },
    });
    fx = identityFixtures(t);
    ttlSeconds =
      t.container.resolve<Pick<Env, 'REFRESH_TOKEN_TTL_DAYS'>>(TOKENS.Env).REFRESH_TOKEN_TTL_DAYS * 86_400;
  });
  afterAll(async () => {
    await t.close();
  });

  describe('issuing tokens', () => {
    it('with X-Nile-Client: web the refresh token goes into an HttpOnly cookie and the body says null', async () => {
      const { email } = await fx.createActive();
      const res = await post('/auth/login', { email, password: PASSWORD }, WEB);
      expect(res.status).toBe(200);
      const body = successBody<AuthTokensDto>(res).data;
      expect(body.refreshToken).toBeNull();
      expect(body.refreshTokenExpiresAt).toEqual(expect.any(String));
      const cookie = refreshCookieOf(res);
      expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookie?.attributes).toEqual(
        expect.arrayContaining([
          'Path=/api/v1/auth',
          'HttpOnly',
          'Secure',
          'SameSite=Strict',
          `Max-Age=${ttlSeconds}`,
        ]),
      );
    });

    it('without the header (native) nothing changes: token in the body, no Set-Cookie', async () => {
      const { email } = await fx.createActive();
      const res = await post('/auth/login', { email, password: PASSWORD });
      expect(successBody<AuthTokensDto>(res).data.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.headers['set-cookie']).toBeUndefined();
      // Any other value of the header is not the web client.
      const other = await post('/auth/login', { email, password: PASSWORD }, { 'X-Nile-Client': 'ios' });
      expect(successBody<AuthTokensDto>(other).data.refreshToken).toEqual(expect.any(String));
      expect(refreshCookieOf(other)).toBeUndefined();
    });

    it('email verification and invite acceptance set the cookie too', async () => {
      const pending = await fx.createPending();
      const verified = await post('/auth/email/verify', { email: pending.email, otp: pending.otp }, WEB);
      expect([successBody<AuthTokensDto>(verified).data.refreshToken, !!refreshCookieOf(verified)]).toEqual([
        null,
        true,
      ]);
      const invited = await fx.createInvited();
      const accepted = await post('/auth/invite/accept', { token: invited.token, password: PASSWORD }, WEB);
      expect([successBody<AuthTokensDto>(accepted).data.refreshToken, !!refreshCookieOf(accepted)]).toEqual([
        null,
        true,
      ]);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates from the cookie; replaying the old cookie is 401 and clears it', async () => {
      const { email } = await fx.createActive();
      const { cookie } = await webLogin(email);
      const res = await post('/auth/refresh', {}, { ...WEB, ...withCookie(cookie) });
      expect(res.status).toBe(200);
      expect(successBody<AuthTokensDto>(res).data.refreshToken).toBeNull();
      const next = refreshCookieOf(res)?.value;
      expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(next).not.toBe(cookie);

      const replay = await post('/auth/refresh', {}, { ...WEB, ...withCookie(cookie) });
      expect([replay.status, errorBody(replay).error.code]).toEqual([401, 'INVALID_REFRESH_TOKEN']);
      expect(refreshCookieOf(replay)).toMatchObject({
        value: '',
        attributes: expect.arrayContaining(['Max-Age=0']) as unknown,
      });
      // Reuse revoked the family, so the rotated cookie is dead too.
      expect((await post('/auth/refresh', {}, { ...WEB, ...withCookie(next ?? '') })).status).toBe(401);
    });

    it('a web client may still send the token in the body; the new one comes back as a cookie', async () => {
      const { session } = await fx.createActive();
      const res = await post('/auth/refresh', { refreshToken: session.refreshToken }, WEB);
      expect(res.status).toBe(200);
      expect(successBody<AuthTokensDto>(res).data.refreshToken).toBeNull();
      expect(refreshCookieOf(res)?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('400 VALIDATION_FAILED: the cookie without the header, the cookie and a body token, neither', async () => {
      const { email, session } = await fx.createActive();
      const { cookie } = await webLogin(email);
      const cases = [
        post('/auth/refresh', {}, withCookie(cookie)),
        post('/auth/refresh', {}, { 'X-Nile-Client': 'WEB', ...withCookie(cookie) }),
        post('/auth/refresh', { refreshToken: session.refreshToken }, { ...WEB, ...withCookie(cookie) }),
        post('/auth/refresh', {}, WEB),
        post('/auth/refresh', { refreshToken: null }, WEB),
      ];
      for (const res of await Promise.all(cases)) {
        expect([res.status, errorBody(res).error.code]).toEqual([400, 'VALIDATION_FAILED']);
        expect(refreshCookieOf(res)).toBeUndefined();
      }
      // None of them used the session up.
      expect((await post('/auth/refresh', {}, { ...WEB, ...withCookie(cookie) })).status).toBe(200);
    });

    it('a native 401 carries no Set-Cookie', async () => {
      const res = await post('/auth/refresh', { refreshToken: 'x'.repeat(43) });
      expect([res.status, res.headers['set-cookie']]).toEqual([401, undefined]);
    });
  });

  describe('POST /auth/logout', () => {
    it('ends the session from the cookie and clears it; native logout sets no cookie', async () => {
      const { email, session } = await fx.createActive();
      const { cookie } = await webLogin(email);
      const res = await post('/auth/logout', {}, { ...WEB, ...withCookie(cookie) });
      expect(res.status).toBe(204);
      expect(refreshCookieOf(res)).toMatchObject({
        value: '',
        attributes: expect.arrayContaining(['Max-Age=0', 'Path=/api/v1/auth']) as unknown,
      });
      expect((await post('/auth/refresh', {}, { ...WEB, ...withCookie(cookie) })).status).toBe(401);

      const native = await post('/auth/logout', { refreshToken: session.refreshToken });
      expect([native.status, native.headers['set-cookie']]).toEqual([204, undefined]);
    });

    it('the cookie without the header is 400 and the session survives', async () => {
      const { email } = await fx.createActive();
      const { cookie } = await webLogin(email);
      const res = await post('/auth/logout', {}, withCookie(cookie));
      expect([res.status, errorBody(res).error.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect((await post('/auth/refresh', {}, { ...WEB, ...withCookie(cookie) })).status).toBe(200);
    });
  });

  describe('POST /auth/password/change', () => {
    it('keeps the session named by the cookie; a dead cookie is 401 and cleared', async () => {
      const { email, session } = await fx.createActive();
      const web = await webLogin(email);
      const change = (cookie: string, newPassword: string, currentPassword: string) =>
        request(t.app)
          .post(`${API}/auth/password/change`)
          .set({ Authorization: `Bearer ${web.tokens.accessToken}`, ...WEB, ...withCookie(cookie) })
          .send({ currentPassword, newPassword });

      const res = await change(web.cookie, NEW_PASSWORD, PASSWORD);
      expect(res.status).toBe(204);
      expect(refreshCookieOf(res)).toBeUndefined();
      expect((await post('/auth/refresh', {}, { ...WEB, ...withCookie(web.cookie) })).status).toBe(200);
      // The other (native) session was revoked.
      expect((await post('/auth/refresh', { refreshToken: session.refreshToken })).status).toBe(401);

      const dead = await change('y'.repeat(43), PASSWORD, NEW_PASSWORD);
      expect([dead.status, errorBody(dead).error.code]).toEqual([401, 'INVALID_REFRESH_TOKEN']);
      expect(refreshCookieOf(dead)?.attributes).toContain('Max-Age=0');
    });
  });

  describe('CORS with credentials', () => {
    it('the preflight allows the listed origin, credentials and X-Nile-Client', async () => {
      const res = await request(t.app).options(`${API}/auth/refresh`).set({
        Origin: APP_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-nile-client,content-type',
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(String(res.headers['access-control-allow-headers']).split(',')).toEqual(
        expect.arrayContaining([
          'Authorization',
          'Content-Type',
          'Idempotency-Key',
          'X-Correlation-Id',
          'X-Nile-Client',
        ]),
      );
    });

    it('another origin gets no Access-Control-Allow-Origin, so the browser blocks the call', async () => {
      const res = await request(t.app)
        .options(`${API}/auth/refresh`)
        .set({ Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      // The cors package still sends Allow-Credentials; without Allow-Origin the browser blocks anyway.
    });

    it('responses expose the correlation id, Retry-After and Idempotent-Replayed to the web client', async () => {
      const res = await request(t.app).get(`${API}/governorates`).set('Origin', APP_ORIGIN);
      expect(String(res.headers['access-control-expose-headers']).split(',')).toEqual([
        'X-Correlation-Id',
        'Retry-After',
        'Idempotent-Replayed',
      ]);
    });
  });

  describe('session events (spec 03 §8.2)', () => {
    it('an admin suspension writes user.suspended; reactivation writes nothing', async () => {
      const admin = await fx.createActiveAdmin();
      const { userId } = await fx.createActive();
      const asAdmin = (path: string, body?: object) =>
        request(t.app)
          .post(`${API}${path}`)
          .set('Authorization', `Bearer ${admin.session.accessToken}`)
          .send(body);
      expect((await asAdmin(`/admin/users/${userId}/suspend`, { reason: 'fraud' })).status).toBe(200);
      expect(await outboxOf('user.suspended', userId)).toEqual([
        { userId, role: 'customer', suspendedAt: expect.any(String) as unknown },
      ]);
      expect((await asAdmin(`/admin/users/${userId}/reactivate`)).status).toBe(200);
      expect(await outboxOf('user.suspended', userId)).toHaveLength(1);
    });

    it('a password reset writes user.sessions_revoked; a failed one writes nothing', async () => {
      const { userId, email } = await fx.createActive();
      await post('/auth/password/forgot', { email });
      const { otp } = await fx.latestSecret(userId, 'password_reset');
      const wrong = await post('/auth/password/reset', {
        email,
        otp: otp === '000000' ? '111111' : '000000',
        newPassword: NEW_PASSWORD,
      });
      expect(wrong.status).toBe(400);
      expect(await outboxOf('user.sessions_revoked', userId)).toEqual([]);
      expect((await post('/auth/password/reset', { email, otp, newPassword: NEW_PASSWORD })).status).toBe(
        204,
      );
      expect(await outboxOf('user.sessions_revoked', userId)).toEqual([
        { userId, reason: 'password_reset', revokedAt: expect.any(String) as unknown },
      ]);
    });
  });
});
