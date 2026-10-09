import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ICustomerDirectory } from '../../src/app/customers';
import {
  type AddressDto,
  type CustomerProfileDto,
  type RegisteredCustomerDto,
} from '../../src/app/customers/dto/customer-response.dto';
import { type AuthTokensDto } from '../../src/app/identity/dto/auth-response.dto';
import { TOKENS } from '../../src/lib/di';
import { addressBody, CUSTOMER_PHONE, customerFixtures, customerRegistration } from '../helpers/customers';
import { errorBody, successBody } from '../helpers/http';
import { API, PASSWORD } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { startTestApp, type TestApp } from '../helpers/test-app';

const MAX_ADDRESSES = 5;
const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

/* Spec 04 over HTTP: happy path, validation, authz, not-found, and the address rules under concurrency. */
describe('customers endpoints', () => {
  let t: TestApp;
  let fx: ReturnType<typeof customerFixtures>;
  let cairoId: string;

  const as = (token: string | undefined) => {
    const auth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
    return {
      get: (path: string) => auth(request(t.app).get(`${API}${path}`)),
      post: (path: string, body?: object) => auth(request(t.app).post(`${API}${path}`)).send(body),
      patch: (path: string, body?: object) => auth(request(t.app).patch(`${API}${path}`)).send(body),
      delete: (path: string) => auth(request(t.app).delete(`${API}${path}`)),
    };
  };
  const register = (body: object) => request(t.app).post(`${API}/auth/register/customer`).send(body);
  const addresses = async (token: string) =>
    successBody<AddressDto[]>(await as(token).get('/me/addresses')).data;
  const defaults = async (token: string) =>
    (await addresses(token)).filter((a) => a.isDefault).map((a) => a.id);
  const addAddress = async (token: string, overrides: Record<string, unknown> = {}) => {
    const res = await as(token).post('/me/addresses', addressBody(cairoId, overrides));
    if (res.status !== 201) throw new Error(`create address failed: ${res.status}`);
    return successBody<AddressDto>(res).data;
  };

  beforeAll(async () => {
    t = await startTestApp({
      envOverrides: {
        RATE_LIMIT_STRICT_AUTH_POINTS: '10000',
        CUSTOMER_MAX_ADDRESSES: String(MAX_ADDRESSES),
      },
    });
    fx = customerFixtures(t);
    cairoId = await fx.governorateId('EG-C');
  });
  afterAll(async () => {
    await t.close();
  });

  describe('POST /auth/register/customer', () => {
    it('201 pending account → OTP email → verify → login → GET /me (the deferred P1 end-to-end)', async () => {
      const body = customerRegistration({ email: `  NEW-${Date.now()}@Example.com ` });
      const email = body.email.trim().toLowerCase();
      const res = await register(body);
      expect(res.status).toBe(201);
      const data = successBody<RegisteredCustomerDto>(res).data;
      expect(data).toEqual({ userId: data.userId, email, status: 'pending_email_verification' });

      const login = () => request(t.app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
      expect(errorBody(await login()).error.code).toBe('EMAIL_NOT_VERIFIED');

      const { otp } = await fx.latestSecret(data.userId, 'email_verification');
      expect((await request(t.app).post(`${API}/auth/email/verify`).send({ email, otp })).status).toBe(200);
      const session = successBody<AuthTokensDto>(await login()).data;

      const me = await as(session.accessToken).get('/me');
      expect(me.status).toBe(200);
      expect(successBody<CustomerProfileDto>(me).data).toMatchObject({
        email,
        firstName: 'Mona',
        lastName: 'Ali',
        phone: CUSTOMER_PHONE,
      });
    });

    it('never writes the password or the OTP to a log line or an outbox row', async () => {
      const body = customerRegistration({ password: 'a very secret passphrase 42' });
      const { userId } = successBody<RegisteredCustomerDto>(await register(body)).data;
      const { otp } = await fx.latestSecret(userId, 'email_verification');
      const outbox = JSON.stringify(
        await t.infra.db.knex('events_outbox').select('payload').where({ aggregate_id: userId }),
      );
      const logs = t.logs.lines.join('\n');
      for (const secret of [body.password, otp ?? 'missing']) {
        expect(outbox).not.toContain(secret);
        expect(logs).not.toContain(secret);
      }
    });

    it('409 EMAIL_ALREADY_REGISTERED, and no customer row is left behind', async () => {
      const { email } = await fx.createActiveCustomer();
      const res = await register(customerRegistration({ email, firstName: 'Second' }));
      expect([res.status, errorBody(res).error.code]).toEqual([409, 'EMAIL_ALREADY_REGISTERED']);
      expect(await t.infra.db.knex('customers').where({ first_name: 'Second' })).toHaveLength(0);
    });

    it('400 VALIDATION_FAILED for bad fields or unknown keys', async () => {
      for (const overrides of [
        { phone: '01001234567' },
        { phone: '+201301234567' },
        { password: 'short' },
        { password: 'x'.repeat(73) },
        { firstName: '   ' },
        { email: 'not-an-email' },
        { role: 'admin' },
      ]) {
        const res = await register(customerRegistration(overrides));
        expect([JSON.stringify(overrides), res.status, errorBody(res).error.code]).toEqual([
          JSON.stringify(overrides),
          400,
          'VALIDATION_FAILED',
        ]);
      }
    });
  });

  describe('authz', () => {
    const routes: [string, 'get' | 'post' | 'patch' | 'delete'][] = [
      ['/me', 'get'],
      ['/me', 'patch'],
      ['/me/addresses', 'get'],
      ['/me/addresses', 'post'],
      [`/me/addresses/${UNKNOWN_ID}`, 'get'],
      [`/me/addresses/${UNKNOWN_ID}`, 'patch'],
      [`/me/addresses/${UNKNOWN_ID}`, 'delete'],
    ];

    it('401 without a token, 403 for another role, 403 for a customer token with no profile', async () => {
      const sellerToken = await signTestAccessToken({ role: 'seller' });
      const orphanToken = await signTestAccessToken({ role: 'customer' });
      for (const [path, method] of routes) {
        const anonymous = await as(undefined)[method](path);
        expect([path, anonymous.status, errorBody(anonymous).error.code]).toEqual([
          path,
          401,
          'UNAUTHENTICATED',
        ]);
        const seller = await as(sellerToken)[method](path);
        expect([path, seller.status, errorBody(seller).error.code]).toEqual([path, 403, 'FORBIDDEN']);
      }
      const orphan = await as(orphanToken).get('/me');
      expect([orphan.status, errorBody(orphan).error.code]).toEqual([403, 'FORBIDDEN']);
    });
  });

  describe('PATCH /me', () => {
    it('200 updates the given fields only', async () => {
      const { accessToken } = await fx.createActiveCustomer();
      const res = await as(accessToken).patch('/me', { firstName: '  Salma ', phone: '+201111234567' });
      expect(res.status).toBe(200);
      expect(successBody<CustomerProfileDto>(res).data).toMatchObject({
        firstName: 'Salma',
        lastName: 'Ali',
        phone: '+201111234567',
      });
    });

    it('400 for an empty body, null, an email change, or a bad phone', async () => {
      const { accessToken } = await fx.createActiveCustomer();
      for (const body of [{}, { firstName: null }, { email: 'new@example.com' }, { phone: '123' }]) {
        const res = await as(accessToken).patch('/me', body);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      }
    });
  });

  describe('addresses', () => {
    it('create → list → get → update → delete', async () => {
      const { accessToken } = await fx.createActiveCustomer();
      const first = await addAddress(accessToken, { floor: '3', landmark: 'Next to the bakery' });
      expect(first).toMatchObject({ label: 'Home', floor: '3', apartment: null, isDefault: true });

      const got = await as(accessToken).get(`/me/addresses/${first.id}`);
      expect(successBody<AddressDto>(got).data).toEqual(first);

      const patched = await as(accessToken).patch(`/me/addresses/${first.id}`, {
        label: 'Work',
        floor: null,
      });
      expect(successBody<AddressDto>(patched).data).toMatchObject({
        label: 'Work',
        floor: null,
        isDefault: true,
      });

      expect((await as(accessToken).delete(`/me/addresses/${first.id}`)).status).toBe(204);
      expect((await as(accessToken).get(`/me/addresses/${first.id}`)).status).toBe(404);
      expect(await addresses(accessToken)).toEqual([]);
      const again = await as(accessToken).delete(`/me/addresses/${first.id}`);
      expect([again.status, errorBody(again).error.code]).toEqual([404, 'ADDRESS_NOT_FOUND']);
    });

    it('the first address is the default; isDefault=true moves it; list = default first, then newest', async () => {
      const { accessToken } = await fx.createActiveCustomer();
      await addAddress(accessToken, { label: 'A' });
      const b = await addAddress(accessToken, { label: 'B' });
      await addAddress(accessToken, { label: 'C', isDefault: true });
      expect((await addresses(accessToken)).map((x) => [x.label, x.isDefault])).toEqual([
        ['C', true],
        ['B', false],
        ['A', false],
      ]);

      await as(accessToken).patch(`/me/addresses/${b.id}`, { isDefault: true });
      expect(await defaults(accessToken)).toEqual([b.id]);

      const unset = await as(accessToken).patch(`/me/addresses/${b.id}`, { isDefault: false });
      expect([unset.status, errorBody(unset).error.code]).toEqual([422, 'DEFAULT_ADDRESS_UNSET_NOT_ALLOWED']);
      expect(await defaults(accessToken)).toEqual([b.id]);
    });

    it('deleting the default leaves none; the next new address becomes the default (C-3)', async () => {
      const { accessToken } = await fx.createActiveCustomer();
      const home = await addAddress(accessToken);
      await addAddress(accessToken, { label: 'Work' });
      await as(accessToken).delete(`/me/addresses/${home.id}`);
      expect(await defaults(accessToken)).toEqual([]);

      const next = await addAddress(accessToken, { label: 'New', isDefault: false });
      expect(next.isDefault).toBe(true);
    });

    it("another customer's address → 404 ADDRESS_NOT_FOUND on get, patch and delete", async () => {
      const owner = await fx.createActiveCustomer();
      const intruder = await fx.createActiveCustomer();
      const address = await addAddress(owner.accessToken);
      const path = `/me/addresses/${address.id}`;
      for (const res of [
        await as(intruder.accessToken).get(path),
        await as(intruder.accessToken).patch(path, { label: 'Mine now' }),
        await as(intruder.accessToken).delete(path),
      ]) {
        expect([res.status, errorBody(res).error.code]).toEqual([404, 'ADDRESS_NOT_FOUND']);
      }
      expect((await as(owner.accessToken).get(path)).status).toBe(200);
    });

    it('422 GOVERNORATE_NOT_FOUND for an unknown governorate on create and update', async () => {
      const { accessToken } = await fx.createActiveCustomer();
      const create = await as(accessToken).post('/me/addresses', addressBody(UNKNOWN_ID));
      expect([create.status, errorBody(create).error.code]).toEqual([422, 'GOVERNORATE_NOT_FOUND']);
      const address = await addAddress(accessToken);
      const update = await as(accessToken).patch(`/me/addresses/${address.id}`, {
        governorateId: UNKNOWN_ID,
      });
      expect([update.status, errorBody(update).error.code]).toEqual([422, 'GOVERNORATE_NOT_FOUND']);
    });

    it('400 VALIDATION_FAILED for bad bodies and a malformed id', async () => {
      const { accessToken } = await fx.createActiveCustomer();
      for (const body of [
        addressBody(cairoId, { isDefault: 'yes' }),
        addressBody(cairoId, { recipientPhone: '+44 20 7946 0000' }),
        addressBody(cairoId, { floor: '12345678901' }),
        addressBody(cairoId, { label: null }),
        addressBody('not-a-uuid'),
        addressBody(cairoId, { extra: true }),
      ]) {
        const res = await as(accessToken).post('/me/addresses', body);
        expect([JSON.stringify(body), res.status, errorBody(res).error.code]).toEqual([
          JSON.stringify(body),
          400,
          'VALIDATION_FAILED',
        ]);
      }
      expect((await as(accessToken).patch(`/me/addresses/${UNKNOWN_ID}`, {})).status).toBe(400);
      expect((await as(accessToken).get('/me/addresses/123')).status).toBe(400);
    });

    it(`the limit (${MAX_ADDRESSES}) holds under parallel creates`, async () => {
      const { accessToken } = await fx.createActiveCustomer();
      const results = await Promise.all(
        Array.from({ length: MAX_ADDRESSES + 3 }, (_, i) =>
          as(accessToken).post('/me/addresses', addressBody(cairoId, { label: `L${i}` })),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(MAX_ADDRESSES);
      expect(results.filter((r) => r.status === 422).map((r) => errorBody(r).error.code)).toEqual(
        Array.from({ length: 3 }, () => 'ADDRESS_LIMIT_REACHED'),
      );
      expect(await addresses(accessToken)).toHaveLength(MAX_ADDRESSES);
      expect(await defaults(accessToken)).toHaveLength(1);
    });

    it('parallel "set default" requests leave exactly one default', async () => {
      const { accessToken } = await fx.createActiveCustomer();
      const created = [];
      for (let i = 0; i < 4; i += 1) created.push(await addAddress(accessToken, { label: `L${i}` }));
      const results = await Promise.all(
        created.map((a) => as(accessToken).patch(`/me/addresses/${a.id}`, { isDefault: true })),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(await defaults(accessToken)).toHaveLength(1);
    });
  });

  describe('public API (spec 04 §2)', () => {
    it('getCustomerIdByUserId and getAddressSnapshot (scoped to the customer)', async () => {
      const api = t.container.resolve<ICustomerDirectory>(TOKENS.CustomerDirectory);
      const owner = await fx.createActiveCustomer();
      const other = await fx.createActiveCustomer();
      const address = await addAddress(owner.accessToken, { apartment: '7' });

      const customerId = await api.getCustomerIdByUserId(owner.userId);
      expect(customerId).toEqual(expect.any(String));
      expect(await api.getCustomerIdByUserId(UNKNOWN_ID)).toBeNull();

      expect(await api.getAddressSnapshot(customerId ?? '', address.id)).toEqual({
        governorateId: cairoId,
        recipientName: 'Mona Ali',
        recipientPhone: CUSTOMER_PHONE,
        city: 'Cairo',
        area: 'Zamalek',
        street: '26th of July St',
        building: '12',
        floor: null,
        apartment: '7',
        landmark: null,
      });
      const otherId = (await api.getCustomerIdByUserId(other.userId)) ?? '';
      await expect(api.getAddressSnapshot(otherId, address.id)).rejects.toMatchObject({
        code: 'ADDRESS_NOT_FOUND',
      });
    });
  });
});

describe('customers registration rate limit', () => {
  it('strict-auth: the same email is limited across client IPs', async () => {
    const t = await startTestApp({
      envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '2', TRUST_PROXY_HOPS: '1' },
    });
    try {
      const body = customerRegistration();
      const statuses = [];
      for (let ip = 1; ip <= 3; ip += 1) {
        const res = await request(t.app)
          .post(`${API}/auth/register/customer`)
          .set('X-Forwarded-For', `203.0.113.${ip}`)
          .send(body);
        statuses.push(res.status);
      }
      // 201, then 409 (already registered), then 429 on the email counter.
      expect(statuses).toEqual([201, 409, 429]);
    } finally {
      await t.close();
    }
  });
});
