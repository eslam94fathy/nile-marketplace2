import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ISellerDirectory } from '../../src/app/sellers';
import {
  type RegisteredSellerDto,
  type SellerProfileDto,
} from '../../src/app/sellers/dto/seller-response.dto';
import { TOKENS } from '../../src/lib/di';
import { errorBody, successBody } from '../helpers/http';
import { API, PASSWORD } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { newBusinessName, SELLER_PHONE, sellerFixtures, sellerRegistration } from '../helpers/sellers';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

/* Spec 05 §4.2–§4.3 and §2 over HTTP: registration, self-service, re-apply, public API. */
describe('sellers endpoints (registration and self-service)', () => {
  let t: TestApp;
  let fx: ReturnType<typeof sellerFixtures>;
  let cairoId: string;
  let gizaId: string;

  const register = (body: object) => request(t.app).post(`${API}/auth/register/seller`).send(body);
  const as = (token: string | undefined) => {
    const auth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
    return {
      get: (path: string) => auth(request(t.app).get(`${API}${path}`)),
      post: (path: string, body?: object) => auth(request(t.app).post(`${API}${path}`)).send(body),
      patch: (path: string, body?: object) => auth(request(t.app).patch(`${API}${path}`)).send(body),
    };
  };
  const userRows = (email: string) => t.infra.db.knex('users').where({ email });

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '10000' } });
    fx = sellerFixtures(t);
    cairoId = await fx.governorateId('EG-C');
    gizaId = await fx.governorateId('EG-GZ');
  });
  afterAll(async () => {
    await t.close();
  });

  describe('POST /auth/register/seller', () => {
    it('201: pending account + pending_approval seller with the default rate and a history row', async () => {
      const body = sellerRegistration(cairoId);
      const res = await register(body);
      expect(res.status).toBe(201);
      const data = successBody<RegisteredSellerDto>(res).data;
      expect(data).toEqual({
        userId: data.userId,
        sellerId: data.sellerId,
        email: body.email,
        status: 'pending_email_verification',
        sellerStatus: 'pending_approval',
      });
      const row = await t.infra.db
        .knex('sellers')
        .where({ id: data.sellerId })
        .first<{ commission_rate: string; status: string; pickup_landmark: string | null }>();
      expect(row).toMatchObject({
        commission_rate: '0.1000',
        status: 'pending_approval',
        pickup_landmark: null,
      });
      expect(
        await t.infra.db
          .knex('seller_status_history')
          .where({ seller_id: data.sellerId })
          .select('from_status', 'to_status', 'actor_user_id'),
      ).toEqual([{ from_status: null, to_status: 'pending_approval', actor_user_id: data.userId }]);
    });

    it('verify → login → GET /seller/profile', async () => {
      const seller = await fx.createVerifiedSeller();
      const login = await request(t.app)
        .post(`${API}/auth/login`)
        .send({ email: seller.email, password: PASSWORD });
      expect(login.status).toBe(200);
      const res = await as(seller.accessToken).get('/seller/profile');
      expect(res.status).toBe(200);
      expect(successBody<SellerProfileDto>(res).data).toMatchObject({
        id: seller.sellerId,
        email: seller.email,
        businessName: seller.businessName,
        contactPhone: SELLER_PHONE,
        pickupAddress: { governorateId: cairoId, city: 'Cairo', landmark: null },
        status: 'pending_approval',
        rejectionReason: null,
        commissionRate: '0.1000',
        approvedAt: null,
      });
    });

    it('never writes the password or the OTP to a log line or an outbox row', async () => {
      const body = sellerRegistration(cairoId, { password: 'seller secret passphrase 99' });
      const { userId } = successBody<RegisteredSellerDto>(await register(body)).data;
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

    it('409 BUSINESS_NAME_TAKEN (case-insensitive), and the user row is rolled back too', async () => {
      const name = newBusinessName();
      expect((await register(sellerRegistration(cairoId, { businessName: name }))).status).toBe(201);
      const second = sellerRegistration(cairoId, { businessName: `  ${name.toUpperCase()} ` });
      const res = await register(second);
      expect([res.status, errorBody(res).error.code]).toEqual([409, 'BUSINESS_NAME_TAKEN']);
      expect(await userRows(second.email)).toHaveLength(0);
    });

    it('409 EMAIL_ALREADY_REGISTERED (an existing customer email too)', async () => {
      const { email } = await fx.createActiveCustomer();
      const res = await register(sellerRegistration(cairoId, { email }));
      expect([res.status, errorBody(res).error.code]).toEqual([409, 'EMAIL_ALREADY_REGISTERED']);
    });

    it('422 GOVERNORATE_NOT_FOUND for an unknown pickup governorate, nothing left behind', async () => {
      const body = sellerRegistration(UNKNOWN_ID);
      const res = await register(body);
      expect([res.status, errorBody(res).error.code]).toEqual([422, 'GOVERNORATE_NOT_FOUND']);
      expect(await userRows(body.email)).toHaveLength(0);
    });

    it('400 VALIDATION_FAILED for bad fields, a bad nested address, or unknown keys', async () => {
      const pickup = sellerRegistration(cairoId).pickupAddress;
      for (const overrides of [
        { businessName: 'A' },
        { businessName: 'x'.repeat(151) },
        { contactPhone: '+2010012345' },
        { pickupAddress: undefined },
        { pickupAddress: 'Cairo' },
        { pickupAddress: { ...pickup, governorateId: 'cairo' } },
        { pickupAddress: { ...pickup, street: '' } },
        { pickupAddress: { ...pickup, floor: '3' } },
        { commissionRate: '0.05' },
      ]) {
        const res = await register(sellerRegistration(cairoId, overrides));
        expect([JSON.stringify(overrides), res.status, errorBody(res).error.code]).toEqual([
          JSON.stringify(overrides),
          400,
          'VALIDATION_FAILED',
        ]);
      }
      const nested = await register(sellerRegistration(cairoId, { pickupAddress: { ...pickup, city: '' } }));
      expect(errorBody(nested).error.details?.map((d) => d.field)).toContain('pickupAddress.city');
    });
  });

  describe('authz', () => {
    it('401 without a token, 403 for another role or a seller token with no profile', async () => {
      const customerToken = await signTestAccessToken({ role: 'customer' });
      const orphanToken = await signTestAccessToken({ role: 'seller' });
      for (const [method, path] of [
        ['get', '/seller/profile'],
        ['patch', '/seller/profile'],
        ['post', '/seller/profile/reapply'],
      ] as const) {
        const anonymous = await as(undefined)[method](path);
        expect([path, anonymous.status, errorBody(anonymous).error.code]).toEqual([
          path,
          401,
          'UNAUTHENTICATED',
        ]);
        const customer = await as(customerToken)[method](path);
        expect([path, customer.status, errorBody(customer).error.code]).toEqual([path, 403, 'FORBIDDEN']);
      }
      const orphan = await as(orphanToken).get('/seller/profile');
      expect([orphan.status, errorBody(orphan).error.code]).toEqual([403, 'FORBIDDEN']);
    });
  });

  describe('PATCH /seller/profile', () => {
    it('200: any status may edit; the pickup address is replaced as a whole', async () => {
      const seller = await fx.createVerifiedSeller();
      await as(seller.accessToken).patch('/seller/profile', {
        pickupAddress: { ...sellerRegistration(cairoId).pickupAddress, landmark: 'Near the mall' },
      });
      const name = newBusinessName();
      const res = await as(seller.accessToken).patch('/seller/profile', {
        businessName: name,
        pickupAddress: {
          governorateId: gizaId,
          city: 'Giza',
          area: 'Dokki',
          street: 'Tahrir St',
          building: '9',
        },
      });
      expect(res.status).toBe(200);
      expect(successBody<SellerProfileDto>(res).data).toMatchObject({
        businessName: name,
        contactPhone: SELLER_PHONE,
        status: 'pending_approval',
        pickupAddress: {
          governorateId: gizaId,
          city: 'Giza',
          area: 'Dokki',
          street: 'Tahrir St',
          building: '9',
          landmark: null,
        },
      });
    });

    it("409 BUSINESS_NAME_TAKEN for another seller's name, 422 for an unknown governorate, 400 for an empty body", async () => {
      const first = await fx.createVerifiedSeller();
      const second = await fx.createVerifiedSeller();
      const taken = await as(second.accessToken).patch('/seller/profile', {
        businessName: first.businessName.toLowerCase(),
      });
      expect([taken.status, errorBody(taken).error.code]).toEqual([409, 'BUSINESS_NAME_TAKEN']);

      const pickup = { ...sellerRegistration(UNKNOWN_ID).pickupAddress };
      const unknown = await as(second.accessToken).patch('/seller/profile', { pickupAddress: pickup });
      expect([unknown.status, errorBody(unknown).error.code]).toEqual([422, 'GOVERNORATE_NOT_FOUND']);

      for (const body of [{}, { businessName: null }, { email: 'x@example.com' }]) {
        expect((await as(second.accessToken).patch('/seller/profile', body)).status).toBe(400);
      }
    });
  });

  describe('POST /seller/profile/reapply', () => {
    it('409 SELLER_INVALID_STATUS_TRANSITION unless rejected', async () => {
      const seller = await fx.createVerifiedSeller();
      const res = await as(seller.accessToken).post('/seller/profile/reapply');
      expect([res.status, errorBody(res).error.code]).toEqual([409, 'SELLER_INVALID_STATUS_TRANSITION']);
    });

    it('200: rejected → pending_approval, the reason is kept, one history row; a second call → 409', async () => {
      const seller = await fx.createVerifiedSeller();
      await fx.forceRejected(seller.sellerId, 'Missing documents');

      const res = await as(seller.accessToken).post('/seller/profile/reapply');
      expect(res.status).toBe(200);
      expect(successBody<SellerProfileDto>(res).data).toMatchObject({
        status: 'pending_approval',
        rejectionReason: 'Missing documents',
      });
      expect(
        await t.infra.db
          .knex('seller_status_history')
          .where({ seller_id: seller.sellerId, from_status: 'rejected' })
          .select('to_status', 'actor_user_id'),
      ).toEqual([{ to_status: 'pending_approval', actor_user_id: seller.userId }]);
      expect((await as(seller.accessToken).post('/seller/profile/reapply')).status).toBe(409);
    });
  });

  describe('public API (spec 05 §2)', () => {
    it('getSellerByUserId, getStatuses, getSummaries, getCheckoutSnapshots (batched, unknown ids left out)', async () => {
      const api = t.container.resolve<ISellerDirectory>(TOKENS.SellerDirectory);
      const a = await fx.createVerifiedSeller();
      const b = await fx.createVerifiedSeller();

      expect(await api.getSellerByUserId(a.userId)).toEqual({
        sellerId: a.sellerId,
        status: 'pending_approval',
      });
      expect(await api.getSellerByUserId(UNKNOWN_ID)).toBeNull();

      const ids = [a.sellerId, b.sellerId, UNKNOWN_ID];
      expect((await api.getStatuses(ids)).map((s) => s.sellerId).sort()).toEqual(
        [a.sellerId, b.sellerId].sort(),
      );
      expect(await api.getSummaries([a.sellerId])).toEqual([
        { sellerId: a.sellerId, businessName: a.businessName },
      ]);

      const [snapshot] = await t.infra.db.run((trx) => api.getCheckoutSnapshots([a.sellerId], trx));
      expect(snapshot).toEqual({
        sellerId: a.sellerId,
        status: 'pending_approval',
        businessName: a.businessName,
        commissionRate: '0.1000',
        pickup: {
          governorateId: cairoId,
          phone: SELLER_PHONE,
          city: 'Cairo',
          area: 'Nasr City',
          street: 'Abbas El Akkad St',
          building: '5',
          landmark: null,
        },
      });
      expect(await api.getStatuses([])).toEqual([]);
    });
  });
});

describe('sellers registration rate limit', () => {
  it('strict-auth: the same email is limited across client IPs', async () => {
    const t = await startTestApp({
      envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '2', TRUST_PROXY_HOPS: '1' },
    });
    try {
      const cairo = (
        await t.infra.db.knex('governorates').select('id').where({ code: 'EG-C' }).first<{ id: string }>()
      )?.id;
      const body = sellerRegistration(cairo ?? '');
      const statuses = [];
      for (let ip = 1; ip <= 3; ip += 1) {
        const res = await request(t.app)
          .post(`${API}/auth/register/seller`)
          .set('X-Forwarded-For', `203.0.113.${ip}`)
          .send(body);
        statuses.push(res.status);
      }
      expect(statuses).toEqual([201, 409, 429]);
    } finally {
      await t.close();
    }
  });
});
