import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AdminListItemDto, type InvitedAdminDto } from '../../src/app/identity/dto/admin-response.dto';
import { type PageMeta } from '../../src/lib/http';
import { errorBody, successBody } from '../helpers/http';
import { API, identityFixtures, newEmail, PASSWORD } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { startTestApp, type TestApp } from '../helpers/test-app';

/* Spec 03 §4.10–§4.13 over HTTP: happy path, validation, authz, not-found, and the state rules. */
describe('identity admin endpoints', () => {
  let t: TestApp;
  let fx: ReturnType<typeof identityFixtures>;
  let admin: { userId: string; accessToken: string };
  let customerToken: string;

  const as = (token: string | undefined) => ({
    post: (path: string, body?: object) => {
      const req = request(t.app).post(`${API}${path}`);
      return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body);
    },
    get: (path: string) => {
      const req = request(t.app).get(`${API}${path}`);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    },
  });
  const asAdmin = () => as(admin.accessToken);
  const uuidv7 = async () =>
    (await t.infra.db.knex.raw<{ rows: { id: string }[] }>('SELECT uuidv7() AS id')).rows[0]?.id ?? '';
  const refresh = (refreshToken: string) => request(t.app).post(`${API}/auth/refresh`).send({ refreshToken });
  const login = (email: string) =>
    request(t.app).post(`${API}/auth/login`).send({ email, password: PASSWORD });

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '10000' } });
    fx = identityFixtures(t);
    const active = await fx.createActiveAdmin();
    admin = { userId: active.userId, accessToken: active.session.accessToken };
    customerToken = await signTestAccessToken({ role: 'customer' });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('authz (every admin route)', () => {
    const routes: [string, 'get' | 'post'][] = [
      ['/admin/admins', 'post'],
      ['/admin/admins', 'get'],
      ['/admin/users/0192f5e0-0000-7000-8000-000000000000/resend-invite', 'post'],
      ['/admin/users/0192f5e0-0000-7000-8000-000000000000/suspend', 'post'],
      ['/admin/users/0192f5e0-0000-7000-8000-000000000000/reactivate', 'post'],
    ];

    it('401 without a token, 403 for a non-admin role', async () => {
      for (const [path, method] of routes) {
        const anonymous = await as(undefined)[method](path);
        expect([path, anonymous.status, errorBody(anonymous).error.code]).toEqual([
          path,
          401,
          'UNAUTHENTICATED',
        ]);
        const customer = await as(customerToken)[method](path);
        expect([path, customer.status, errorBody(customer).error.code]).toEqual([path, 403, 'FORBIDDEN']);
      }
    });
  });

  describe('POST /admin/admins', () => {
    it('201: an invited admin, and the invite email is queued', async () => {
      const email = newEmail();
      const res = await asAdmin().post('/admin/admins', { email: ` ${email.toUpperCase()} ` });
      expect(res.status).toBe(201);
      const data = successBody<InvitedAdminDto>(res).data;
      expect(data).toMatchObject({ email, role: 'admin', status: 'invited' });
      expect(new Date(data.createdAt).toISOString()).toBe(data.createdAt);
      expect(await fx.inviteToken(data.id)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('409 EMAIL_ALREADY_REGISTERED for an existing email (any role)', async () => {
      const { email } = await fx.createActive();
      const res = await asAdmin().post('/admin/admins', { email });
      expect([res.status, errorBody(res).error.code]).toEqual([409, 'EMAIL_ALREADY_REGISTERED']);
    });

    it('400 VALIDATION_FAILED for a bad email or an extra field', async () => {
      expect(errorBody(await asAdmin().post('/admin/admins', { email: 'nope' })).error.code).toBe(
        'VALIDATION_FAILED',
      );
      const extra = await asAdmin().post('/admin/admins', { email: newEmail(), role: 'customer' });
      expect(errorBody(extra).error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /admin/admins', () => {
    it('lists only admins, newest first, with cursor pagination', async () => {
      await fx.createActive(); // a customer: never listed
      for (let i = 0; i < 3; i += 1) await asAdmin().post('/admin/admins', { email: newEmail() });

      const all: AdminListItemDto[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
        const res = await asAdmin().get(`/admin/admins${query}`);
        expect(res.status).toBe(200);
        const body = successBody<AdminListItemDto[]>(res);
        expect(body.data.length).toBeLessThanOrEqual(2);
        all.push(...body.data);
        cursor = (body.meta as PageMeta).nextCursor;
      } while (cursor);

      expect(all.length).toBeGreaterThanOrEqual(4);
      expect(new Set(all.map((a) => a.id)).size).toBe(all.length);
      const created = all.map((a) => a.createdAt);
      expect([...created].sort().reverse()).toEqual(created);
      expect(all.find((a) => a.id === admin.userId)).toMatchObject({ status: 'active' });
      expect(Object.keys(all[0] ?? {}).sort()).toEqual(
        ['createdAt', 'email', 'emailVerifiedAt', 'id', 'lastLoginAt', 'status'].sort(),
      );
    });

    it('filters by status and createdAt', async () => {
      const res = await asAdmin().get('/admin/admins?status[in]=invited&createdAt[gte]=2020-01-01');
      const items = successBody<AdminListItemDto[]>(res).data;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((a) => a.status === 'invited')).toBe(true);
    });

    it('400 INVALID_QUERY for an unknown field, operator or sort', async () => {
      for (const query of ['?email=x', '?status[gte]=active', '?sort=email', '?limit=0', '?status=bogus']) {
        const res = await asAdmin().get(`/admin/admins${query}`);
        expect([query, res.status, errorBody(res).error.code]).toEqual([query, 400, 'INVALID_QUERY']);
      }
    });
  });

  describe('POST /admin/users/:userId/resend-invite', () => {
    it('204: a new link replaces the old one', async () => {
      const { userId, token: oldToken } = await fx.createInvited();
      expect((await asAdmin().post(`/admin/users/${userId}/resend-invite`)).status).toBe(204);
      const newToken = await fx.inviteToken(userId);
      expect(newToken).not.toBe(oldToken);

      const accept = (token: string) =>
        request(t.app).post(`${API}/auth/invite/accept`).send({ token, password: PASSWORD });
      expect(errorBody(await accept(oldToken)).error.code).toBe('INVALID_INVITE_TOKEN');
      expect((await accept(newToken)).status).toBe(200);
    });

    it('works for invited delivery agents too', async () => {
      const { userId } = await fx.createInvited(newEmail(), 'delivery_agent');
      expect((await asAdmin().post(`/admin/users/${userId}/resend-invite`)).status).toBe(204);
    });

    it('404 USER_NOT_FOUND, 409 USER_NOT_INVITED, 400 for a non-v7 id', async () => {
      const missing = await asAdmin().post(`/admin/users/${await uuidv7()}/resend-invite`);
      expect([missing.status, errorBody(missing).error.code]).toEqual([404, 'USER_NOT_FOUND']);
      const { userId } = await fx.createActive();
      const active = await asAdmin().post(`/admin/users/${userId}/resend-invite`);
      expect([active.status, errorBody(active).error.code]).toEqual([409, 'USER_NOT_INVITED']);
      const bad = await asAdmin().post('/admin/users/6f1c2a7e-3b0d-4c3e-9a51-2b7d1f0e8c44/resend-invite');
      expect(errorBody(bad).error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /admin/users/:userId/suspend and /reactivate', () => {
    it('suspend revokes every session and blocks login; reactivate restores login', async () => {
      const { userId, email, session } = await fx.createActive();
      const res = await asAdmin().post(`/admin/users/${userId}/suspend`, { reason: '  fraud report  ' });
      expect(res.status).toBe(200);
      expect(successBody(res).data).toEqual({ id: userId, email, role: 'customer', status: 'suspended' });
      expect((await refresh(session.refreshToken)).status).toBe(401);
      expect(errorBody(await login(email)).error.code).toBe('ACCOUNT_SUSPENDED');
      expect(t.logs.entries().some((e) => e.event === 'USER_SUSPENDED' && e.reason === 'fraud report')).toBe(
        true,
      );

      const again = await asAdmin().post(`/admin/users/${userId}/suspend`, { reason: 'again' });
      expect([again.status, errorBody(again).error.code]).toEqual([409, 'USER_INVALID_STATUS_TRANSITION']);

      const back = await asAdmin().post(`/admin/users/${userId}/reactivate`);
      expect([back.status, successBody<{ status: string }>(back).data.status]).toEqual([200, 'active']);
      expect((await login(email)).status).toBe(200);
      const twice = await asAdmin().post(`/admin/users/${userId}/reactivate`);
      expect(errorBody(twice).error.code).toBe('USER_INVALID_STATUS_TRANSITION');
    });

    it('can suspend another admin, not itself', async () => {
      const other = await fx.createActiveAdmin();
      expect((await asAdmin().post(`/admin/users/${other.userId}/suspend`, { reason: 'left' })).status).toBe(
        200,
      );
      const self = await asAdmin().post(`/admin/users/${admin.userId}/suspend`, { reason: 'oops' });
      expect([self.status, errorBody(self).error.code]).toEqual([409, 'CANNOT_SUSPEND_SELF']);
    });

    it('409 for sellers, delivery agents and accounts that are not active (S-2)', async () => {
      const seller = await fx.createActive('seller');
      const agent = await fx.createInvited(newEmail(), 'delivery_agent');
      const pending = await fx.createPending();
      for (const userId of [seller.userId, agent.userId, pending.userId]) {
        const res = await asAdmin().post(`/admin/users/${userId}/suspend`, { reason: 'test' });
        expect([res.status, errorBody(res).error.code]).toEqual([409, 'USER_INVALID_STATUS_TRANSITION']);
      }
    });

    it('400 for a missing or too short reason; 404 for an unknown user', async () => {
      const { userId } = await fx.createActive();
      expect(errorBody(await asAdmin().post(`/admin/users/${userId}/suspend`, {})).error.code).toBe(
        'VALIDATION_FAILED',
      );
      expect(
        errorBody(await asAdmin().post(`/admin/users/${userId}/suspend`, { reason: ' a ' })).error.code,
      ).toBe('VALIDATION_FAILED');
      const missing = await asAdmin().post(`/admin/users/${await uuidv7()}/reactivate`);
      expect([missing.status, errorBody(missing).error.code]).toEqual([404, 'USER_NOT_FOUND']);
    });
  });

  it('every admin endpoint is in the OpenAPI document', async () => {
    const doc = (await request(t.app).get(`${API}/docs/openapi.json`)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(doc.paths[`${API}/admin/admins`] ?? {}).sort()).toEqual(['get', 'post']);
    for (const action of ['resend-invite', 'suspend', 'reactivate']) {
      expect(doc.paths).toHaveProperty([`${API}/admin/users/{userId}/${action}`]);
    }
  });
});
