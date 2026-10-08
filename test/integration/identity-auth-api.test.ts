import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IAccountService } from '../../src/app/identity';
import { type AuthTokensDto, type MessageDto } from '../../src/app/identity/dto/auth-response.dto';
import { TOKENS } from '../../src/lib/di';
import { errorBody, successBody } from '../helpers/http';
import { signTestAccessToken } from '../helpers/jwt';
import { startTestApp, type TestApp } from '../helpers/test-app';

/*
 * Spec 03 §4.2–§4.9b over HTTP against real Postgres/Redis: happy path, validation, authz,
 * plus the security properties (generic answers, reuse detection, attempt counting, no plain secrets).
 */
const API = '/api/v1';
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'another long passphrase';

type Template = 'email_verification' | 'password_reset' | 'account_invite';

describe('identity auth endpoints', () => {
  let t: TestApp;
  let accounts: IAccountService;

  const post = (path: string, body: unknown) =>
    request(t.app)
      .post(`${API}${path}`)
      .send(body as object);
  const newEmail = () => `user-${randomUUID()}@example.com`;

  /** The decrypted secret of the latest email of `template` queued for `userId`. */
  async function latestSecret(userId: string, template: Template): Promise<Record<string, string>> {
    const row = await t.infra.db
      .knex('events_outbox')
      .select('payload')
      .where({ aggregate_id: userId, event_type: 'notification.email_requested' })
      .whereRaw("payload->>'template' = ?", [template])
      .orderBy('id', 'desc')
      .first<{ payload: { encryptedSecrets: string } } | undefined>();
    if (!row) throw new Error(`no ${template} email for ${userId}`);
    return JSON.parse(
      t.infra.secretBox.open(row.payload.encryptedSecrets, `${userId}:${template}`),
    ) as Record<string, string>;
  }

  async function createPending(email = newEmail()): Promise<{ userId: string; email: string; otp: string }> {
    const { userId } = await t.infra.db.run((trx) =>
      accounts.createPendingUser({ email, password: PASSWORD, role: 'customer' }, trx),
    );
    const { otp } = await latestSecret(userId, 'email_verification');
    if (!otp) throw new Error('missing otp');
    return { userId, email, otp };
  }

  /** A verified, logged-in customer. */
  async function createActive(): Promise<{ userId: string; email: string; session: AuthTokensDto }> {
    const { userId, email, otp } = await createPending();
    const res = await post('/auth/email/verify', { email, otp });
    expect(res.status).toBe(200);
    return { userId, email, session: successBody<AuthTokensDto>(res).data };
  }

  async function createInvited(
    email = newEmail(),
  ): Promise<{ userId: string; email: string; token: string }> {
    const { userId } = await t.infra.db.run((trx) =>
      accounts.createInvitedUser({ email, role: 'admin' }, trx),
    );
    const { inviteUrl } = await latestSecret(userId, 'account_invite');
    const token = new URL(inviteUrl ?? '').searchParams.get('token');
    if (!token) throw new Error('missing invite token');
    return { userId, email, token };
  }

  const login = (email: string, password = PASSWORD, deviceName?: string) =>
    post('/auth/login', deviceName === undefined ? { email, password } : { email, password, deviceName });
  const refresh = (refreshToken: string) => post('/auth/refresh', { refreshToken });
  const wrongOtp = (otp: string) => (otp === '000000' ? '111111' : '000000');
  const setStatus = (userId: string, status: string) =>
    t.infra.db.knex('users').where({ id: userId }).update({ status });
  /** Moves the user's codes out of the resend cooldown. */
  const ageCodes = (userId: string) =>
    t.infra.db
      .knex('verification_codes')
      .where({ user_id: userId })
      .update({ created_at: t.infra.db.knex.raw("now() - interval '1 hour'") });

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '10000' } });
    accounts = t.container.resolve<IAccountService>(TOKENS.AccountService);
  });
  afterAll(async () => {
    await t.close();
  });

  describe('POST /auth/email/verify', () => {
    it('activates the account and logs the user in', async () => {
      const { userId, email, otp } = await createPending();
      const res = await post('/auth/email/verify', { email: `  ${email.toUpperCase()} `, otp });
      expect(res.status).toBe(200);
      const data = successBody<AuthTokensDto>(res).data;
      expect(data.user).toEqual({ id: userId, email, role: 'customer', status: 'active' });
      expect(data.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await refresh(data.refreshToken)).status).toBe(200);
    });

    it('400 VALIDATION_FAILED on a malformed body or an unknown key', async () => {
      for (const body of [
        { email: 'not-an-email', otp: '123456' },
        { email: newEmail(), otp: '12345' },
        {},
      ]) {
        const res = await post('/auth/email/verify', body);
        expect([res.status, errorBody(res).error.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      const extra = await post('/auth/email/verify', { email: newEmail(), otp: '123456', role: 'admin' });
      expect(errorBody(extra).error.code).toBe('VALIDATION_FAILED');
    });

    it('INVALID_OTP for an unknown email, a wrong code and an already verified account', async () => {
      expect(
        errorBody(await post('/auth/email/verify', { email: newEmail(), otp: '123456' })).error.code,
      ).toBe('INVALID_OTP');
      const { email, otp } = await createPending();
      const wrong = await post('/auth/email/verify', { email, otp: wrongOtp(otp) });
      expect([wrong.status, errorBody(wrong).error.code]).toEqual([400, 'INVALID_OTP']);
      expect((await post('/auth/email/verify', { email, otp })).status).toBe(200);
      expect(errorBody(await post('/auth/email/verify', { email, otp })).error.code).toBe('INVALID_OTP');
    });

    it('after OTP_MAX_ATTEMPTS wrong codes even the right code fails', async () => {
      const { email, otp } = await createPending();
      for (let i = 0; i < 5; i += 1) await post('/auth/email/verify', { email, otp: wrongOtp(otp) });
      expect(errorBody(await post('/auth/email/verify', { email, otp })).error.code).toBe('INVALID_OTP');
    });
  });

  describe('POST /auth/email/resend-otp', () => {
    it('same answer for every outcome; a new code replaces the old one outside the cooldown', async () => {
      const { userId, email, otp: first } = await createPending();
      const unknown = await post('/auth/email/resend-otp', { email: newEmail() });
      const inCooldown = await post('/auth/email/resend-otp', { email });
      expect(unknown.status).toBe(200);
      expect(successBody<MessageDto>(inCooldown).data).toEqual(successBody<MessageDto>(unknown).data);
      expect((await latestSecret(userId, 'email_verification')).otp).toBe(first);

      await ageCodes(userId);
      expect((await post('/auth/email/resend-otp', { email })).status).toBe(200);
      const { otp: second } = await latestSecret(userId, 'email_verification');
      expect(second).not.toBe(first);
      if (second !== first) {
        expect(errorBody(await post('/auth/email/verify', { email, otp: first })).error.code).toBe(
          'INVALID_OTP',
        );
      }
      expect((await post('/auth/email/verify', { email, otp: second })).status).toBe(200);
    });

    it('400 VALIDATION_FAILED without an email', async () => {
      expect((await post('/auth/email/resend-otp', {})).status).toBe(400);
    });
  });

  describe('POST /auth/login', () => {
    it('logs in an active user and records the device name', async () => {
      const { userId, email } = await createActive();
      const res = await login(email, PASSWORD, 'Pixel 9');
      expect(res.status).toBe(200);
      const row = await t.infra.db
        .knex('refresh_tokens')
        .where({ user_id: userId, user_agent: 'Pixel 9' })
        .first<{ id: string } | undefined>('id');
      expect(row).toBeDefined();
      const user = await t.infra.db
        .knex('users')
        .where({ id: userId })
        .first<{ last_login_at: Date | null }>();
      expect(user.last_login_at).not.toBeNull();
    });

    it('wrong password, unknown email and invited account all get the same 401', async () => {
      const { email } = await createActive();
      const { email: invited } = await createInvited();
      const answers = await Promise.all([
        login(email, 'wrong password!'),
        login(newEmail()),
        login(invited, 'any password at all'),
      ]);
      for (const res of answers) {
        expect(res.status).toBe(401);
        expect(errorBody(res).error).toEqual(errorBody(answers[0] ?? res).error);
        expect(errorBody(res).error.code).toBe('INVALID_CREDENTIALS');
      }
    });

    it('status errors only after a correct password', async () => {
      const { email } = await createPending();
      expect(errorBody(await login(email)).error.code).toBe('EMAIL_NOT_VERIFIED');
      expect(errorBody(await login(email, 'wrong password!')).error.code).toBe('INVALID_CREDENTIALS');

      const active = await createActive();
      await setStatus(active.userId, 'suspended');
      const suspended = await login(active.email);
      expect([suspended.status, errorBody(suspended).error.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
    });

    it('400 on a null deviceName or a password over 72 bytes', async () => {
      const { email } = await createActive();
      expect((await post('/auth/login', { email, password: PASSWORD, deviceName: null })).status).toBe(400);
      expect((await login(email, 'é'.repeat(37))).status).toBe(400);
    });
  });

  describe('POST /auth/refresh and /auth/logout', () => {
    it('rotates; replaying the old token revokes the whole family', async () => {
      const { session } = await createActive();
      const rotated = await refresh(session.refreshToken);
      expect(rotated.status).toBe(200);
      const next = successBody<AuthTokensDto>(rotated).data.refreshToken;

      const replay = await refresh(session.refreshToken);
      expect([replay.status, errorBody(replay).error.code]).toEqual([401, 'INVALID_REFRESH_TOKEN']);
      expect((await refresh(next)).status).toBe(401);
      expect(t.logs.entries().some((e) => e.event === 'REFRESH_TOKEN_REUSE')).toBe(true);
    });

    it('two concurrent refreshes of the same token: exactly one succeeds', async () => {
      const { session } = await createActive();
      const statuses = (
        await Promise.all([refresh(session.refreshToken), refresh(session.refreshToken)])
      ).map((res) => res.status);
      expect(statuses.sort()).toEqual([200, 401]);
    });

    it('400 on a token of the wrong length; 401 on an unknown one', async () => {
      expect((await refresh('short')).status).toBe(400);
      expect((await refresh('A'.repeat(43))).status).toBe(401);
    });

    it('logout ends the session and is always 204', async () => {
      const { session } = await createActive();
      expect((await post('/auth/logout', { refreshToken: session.refreshToken })).status).toBe(204);
      expect((await refresh(session.refreshToken)).status).toBe(401);
      expect((await post('/auth/logout', { refreshToken: 'B'.repeat(43) })).status).toBe(204);
      expect((await post('/auth/logout', {})).status).toBe(400);
    });
  });

  describe('POST /auth/password/forgot and /auth/password/reset', () => {
    it('resets the password and revokes every session', async () => {
      const { userId, email, session } = await createActive();
      const forgot = await post('/auth/password/forgot', { email });
      const unknown = await post('/auth/password/forgot', { email: newEmail() });
      expect(successBody<MessageDto>(forgot).data).toEqual(successBody<MessageDto>(unknown).data);

      const { otp } = await latestSecret(userId, 'password_reset');
      const res = await post('/auth/password/reset', { email, otp, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(204);
      expect((await refresh(session.refreshToken)).status).toBe(401);
      expect(errorBody(await login(email)).error.code).toBe('INVALID_CREDENTIALS');
      expect((await login(email, NEW_PASSWORD)).status).toBe(200);
      // Single use.
      expect(
        errorBody(await post('/auth/password/reset', { email, otp, newPassword: PASSWORD })).error.code,
      ).toBe('INVALID_OTP');
    });

    it('no code for accounts that are not active', async () => {
      const { userId, email } = await createPending();
      await post('/auth/password/forgot', { email });
      await expect(latestSecret(userId, 'password_reset')).rejects.toThrow();
    });

    it('INVALID_OTP for a wrong code; 400 for a short new password', async () => {
      const { userId, email } = await createActive();
      await post('/auth/password/forgot', { email });
      const { otp = '' } = await latestSecret(userId, 'password_reset');
      const wrong = await post('/auth/password/reset', {
        email,
        otp: wrongOtp(otp),
        newPassword: NEW_PASSWORD,
      });
      expect([wrong.status, errorBody(wrong).error.code]).toEqual([400, 'INVALID_OTP']);
      const short = await post('/auth/password/reset', { email, otp, newPassword: 'short' });
      expect(errorBody(short).error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /auth/invite/accept', () => {
    it('sets the password, activates the account and logs in', async () => {
      const { userId, email, token } = await createInvited();
      const res = await post('/auth/invite/accept', { token, password: PASSWORD });
      expect(res.status).toBe(200);
      expect(successBody<AuthTokensDto>(res).data.user).toEqual({
        id: userId,
        email,
        role: 'admin',
        status: 'active',
      });
      expect((await login(email)).status).toBe(200);
      // Single use.
      expect(errorBody(await post('/auth/invite/accept', { token, password: PASSWORD })).error.code).toBe(
        'INVALID_INVITE_TOKEN',
      );
    });

    it('INVALID_INVITE_TOKEN for an unknown token; 400 for a malformed one', async () => {
      const res = await post('/auth/invite/accept', { token: 'C'.repeat(43), password: PASSWORD });
      expect([res.status, errorBody(res).error.code]).toEqual([400, 'INVALID_INVITE_TOKEN']);
      expect(
        errorBody(await post('/auth/invite/accept', { token: 'x', password: PASSWORD })).error.code,
      ).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /auth/password/change', () => {
    const change = (accessToken: string | undefined, body: unknown) => {
      const req = request(t.app).post(`${API}/auth/password/change`);
      return (accessToken ? req.set('Authorization', `Bearer ${accessToken}`) : req).send(body as object);
    };

    it('changes the password and keeps only the current session', async () => {
      const { email, session } = await createActive();
      const other = successBody<AuthTokensDto>(await login(email)).data;
      const res = await change(session.accessToken, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        refreshToken: session.refreshToken,
      });
      expect(res.status).toBe(204);
      expect((await refresh(session.refreshToken)).status).toBe(200);
      expect((await refresh(other.refreshToken)).status).toBe(401);
      expect((await login(email, NEW_PASSWORD)).status).toBe(200);
    });

    it('401 UNAUTHENTICATED without a valid access token', async () => {
      const body = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, refreshToken: 'D'.repeat(43) };
      expect(errorBody(await change(undefined, body)).error.code).toBe('UNAUTHENTICATED');
      expect((await change(await signTestAccessToken({ expiresInSeconds: -10 }), body)).status).toBe(401);
    });

    it('domain errors: wrong current password, unchanged password, a session of another user', async () => {
      const { session } = await createActive();
      const stranger = await createActive();
      const base = { refreshToken: session.refreshToken };

      const wrong = await change(session.accessToken, {
        ...base,
        currentPassword: 'nope',
        newPassword: NEW_PASSWORD,
      });
      expect([wrong.status, errorBody(wrong).error.code]).toEqual([400, 'INVALID_CURRENT_PASSWORD']);
      const same = await change(session.accessToken, {
        ...base,
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
      });
      expect([same.status, errorBody(same).error.code]).toEqual([422, 'PASSWORD_UNCHANGED']);
      const foreign = await change(session.accessToken, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        refreshToken: stranger.session.refreshToken,
      });
      expect([foreign.status, errorBody(foreign).error.code]).toEqual([401, 'INVALID_REFRESH_TOKEN']);
      // Nothing changed.
      expect((await refresh(stranger.session.refreshToken)).status).toBe(200);
    });

    it('400 VALIDATION_FAILED on a missing field', async () => {
      const { session } = await createActive();
      const res = await change(session.accessToken, { currentPassword: PASSWORD });
      expect(errorBody(res).error.code).toBe('VALIDATION_FAILED');
    });
  });

  it('no OTP, invite token or password in plain text in the outbox or the logs', async () => {
    const { userId, email, otp } = await createPending();
    const { userId: invitedId, token } = await createInvited();
    await post('/auth/email/verify', { email, otp });
    const payloads = JSON.stringify(
      await t.infra.db.knex('events_outbox').select('payload').whereIn('aggregate_id', [userId, invitedId]),
    );
    const logs = t.logs.lines.join('\n');
    for (const secret of [otp, token, PASSWORD]) {
      expect(payloads).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
  });

  it('every auth endpoint is in the OpenAPI document', async () => {
    const doc = (await request(t.app).get(`${API}/docs/openapi.json`)).body as {
      paths: Record<string, unknown>;
    };
    for (const path of [
      'email/verify',
      'email/resend-otp',
      'login',
      'refresh',
      'logout',
      'password/forgot',
      'password/reset',
      'password/change',
      'invite/accept',
    ]) {
      expect(doc.paths).toHaveProperty([`${API}/auth/${path}`]);
    }
  });
});

describe('identity auth rate limits', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({
      envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '1', RATE_LIMIT_REFRESH_POINTS: '1' },
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('strict-auth and refresh limits apply to every public auth endpoint', async () => {
    // One point per window: the second call of each endpoint is over the limit.
    const token = 'E'.repeat(43);
    const cases: [string, Record<string, unknown>][] = [
      ['/auth/email/verify', { email: 'a@example.com', otp: '123456' }],
      ['/auth/email/resend-otp', { email: 'b@example.com' }],
      ['/auth/login', { email: 'c@example.com', password: PASSWORD }],
      ['/auth/password/forgot', { email: 'd@example.com' }],
      ['/auth/password/reset', { email: 'e@example.com', otp: '123456', newPassword: NEW_PASSWORD }],
      ['/auth/invite/accept', { token, password: PASSWORD }],
      ['/auth/refresh', { refreshToken: token }],
      ['/auth/logout', { refreshToken: token }],
    ];
    for (const [path, body] of cases) {
      await request(t.app).post(`${API}${path}`).send(body);
      const res = await request(t.app).post(`${API}${path}`).send(body);
      expect([path, res.status, errorBody(res).error.code]).toEqual([path, 429, 'RATE_LIMITED']);
    }
  });

  it('change password counts against the account email it shares with login', async () => {
    // Trusting one proxy hop lets each request come from a different client IP,
    // so only the email counter can reach the limit.
    const fresh = await startTestApp({
      envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '3', TRUST_PROXY_HOPS: '1' },
    });
    try {
      const accounts = fresh.container.resolve<IAccountService>(TOKENS.AccountService);
      const email = `limited-${randomUUID()}@example.com`;
      const { userId } = await fresh.infra.db.run((trx) =>
        accounts.createPendingUser({ email, password: PASSWORD, role: 'customer' }, trx),
      );
      const accessToken = await signTestAccessToken({ sub: userId });
      const body = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, refreshToken: 'F'.repeat(43) };
      let ip = 0;
      const fromNewIp = (path: string) =>
        request(fresh.app)
          .post(`${API}${path}`)
          .set('X-Forwarded-For', `203.0.113.${(ip += 1)}`);
      const change = () =>
        fromNewIp('/auth/password/change').set('Authorization', `Bearer ${accessToken}`).send(body);

      // 1 login + 2 changes = 3 points on the email; the next change is over.
      await fromNewIp('/auth/login').send({ email, password: PASSWORD });
      expect((await change()).status).not.toBe(429);
      expect((await change()).status).not.toBe(429);
      const res = await change();
      expect([res.status, errorBody(res).error.code]).toEqual([429, 'RATE_LIMITED']);
    } finally {
      await fresh.close();
    }
  });
});
