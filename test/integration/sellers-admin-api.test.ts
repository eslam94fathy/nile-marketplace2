import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AdminSellerDetailDto,
  type AdminSellerListItemDto,
  type CommissionSettingsDto,
} from '../../src/app/sellers/dto/seller-admin-response.dto';
import {
  type RegisteredSellerDto,
  type SellerProfileDto,
} from '../../src/app/sellers/dto/seller-response.dto';
import { type PageMeta } from '../../src/lib/http';
import { errorBody, successBody } from '../helpers/http';
import { API, PASSWORD } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { sellerFixtures, sellerRegistration } from '../helpers/sellers';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

/* Spec 05 §4.4 over HTTP: the approval lifecycle, events, commission, settings, list and detail. */
describe('sellers admin endpoints', () => {
  let t: TestApp;
  let fx: ReturnType<typeof sellerFixtures>;
  let admin: { userId: string; token: string };
  let cairoId: string;

  const as = (token: string | undefined) => {
    const auth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
    return {
      get: (path: string) => auth(request(t.app).get(`${API}${path}`)),
      post: (path: string, body?: object) => auth(request(t.app).post(`${API}${path}`)).send(body),
      put: (path: string, body?: object) => auth(request(t.app).put(`${API}${path}`)).send(body),
    };
  };
  const asAdmin = () => as(admin.token);
  const detail = (res: request.Response) => successBody<AdminSellerDetailDto>(res).data;
  const outboxEvents = (sellerId: string) =>
    t.infra.db
      .knex('events_outbox')
      .where({ aggregate_id: sellerId })
      .orderBy('id')
      .select<{ event_type: string; payload: Record<string, unknown> }[]>('event_type', 'payload');
  const approved = async () => {
    const seller = await fx.createVerifiedSeller();
    expect((await asAdmin().post(`/admin/sellers/${seller.sellerId}/approve`)).status).toBe(200);
    return seller;
  };

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '10000' } });
    fx = sellerFixtures(t);
    const active = await fx.createActiveAdmin();
    admin = { userId: active.userId, token: active.session.accessToken };
    cairoId = await fx.governorateId('EG-C');
  });
  afterAll(async () => {
    await t.close();
  });

  describe('authz (every admin route)', () => {
    const id = UNKNOWN_ID;
    const routes: [string, 'get' | 'post' | 'put'][] = [
      ['/admin/sellers', 'get'],
      [`/admin/sellers/${id}`, 'get'],
      [`/admin/sellers/${id}/approve`, 'post'],
      [`/admin/sellers/${id}/reject`, 'post'],
      [`/admin/sellers/${id}/suspend`, 'post'],
      [`/admin/sellers/${id}/reinstate`, 'post'],
      [`/admin/sellers/${id}/commission-rate`, 'put'],
      ['/admin/settings/commission', 'get'],
      ['/admin/settings/commission', 'put'],
    ];

    it('401 without a token, 403 for a seller or customer', async () => {
      const others = [
        await signTestAccessToken({ role: 'seller' }),
        await signTestAccessToken({ role: 'customer' }),
      ];
      for (const [path, method] of routes) {
        const anonymous = await as(undefined)[method](path);
        expect([path, anonymous.status, errorBody(anonymous).error.code]).toEqual([
          path,
          401,
          'UNAUTHENTICATED',
        ]);
        for (const token of others) {
          const res = await as(token)[method](path);
          expect([path, res.status, errorBody(res).error.code]).toEqual([path, 403, 'FORBIDDEN']);
        }
      }
    });
  });

  describe('approve', () => {
    it('409 SELLER_EMAIL_NOT_VERIFIED before the email is verified (Q-40)', async () => {
      const res = await request(t.app).post(`${API}/auth/register/seller`).send(sellerRegistration(cairoId));
      const { sellerId } = successBody<RegisteredSellerDto>(res).data;
      expect(detail(await asAdmin().get(`/admin/sellers/${sellerId}`)).emailVerified).toBe(false);
      const approve = await asAdmin().post(`/admin/sellers/${sellerId}/approve`);
      expect([approve.status, errorBody(approve).error.code]).toEqual([409, 'SELLER_EMAIL_NOT_VERIFIED']);
    });

    it('200: approved, approvedAt set, history row by the admin, seller.approved in the outbox', async () => {
      const seller = await fx.createVerifiedSeller();
      const res = await asAdmin().post(`/admin/sellers/${seller.sellerId}/approve`);
      expect(res.status).toBe(200);
      const data = detail(res);
      expect(data).toMatchObject({ status: 'approved', emailVerified: true, email: seller.email });
      expect(data.approvedAt).not.toBeNull();
      expect(data.statusHistory[0]).toMatchObject({
        fromStatus: 'pending_approval',
        toStatus: 'approved',
        actorUserId: admin.userId,
      });
      expect(await outboxEvents(seller.sellerId)).toEqual([
        {
          event_type: 'seller.approved',
          payload: { sellerId: seller.sellerId, userId: seller.userId, previousStatus: 'pending_approval' },
        },
      ]);
      const again = await asAdmin().post(`/admin/sellers/${seller.sellerId}/approve`);
      expect([again.status, errorBody(again).error.code]).toEqual([409, 'SELLER_INVALID_STATUS_TRANSITION']);
    });

    it('two parallel approvals: one 200, one 409, one history row, one event', async () => {
      const seller = await fx.createVerifiedSeller();
      const results = await Promise.all([
        asAdmin().post(`/admin/sellers/${seller.sellerId}/approve`),
        asAdmin().post(`/admin/sellers/${seller.sellerId}/approve`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const history = await t.infra.db
        .knex('seller_status_history')
        .where({ seller_id: seller.sellerId, to_status: 'approved' });
      expect(history).toHaveLength(1);
      expect(await outboxEvents(seller.sellerId)).toHaveLength(1);
    });

    it('404 SELLER_NOT_FOUND for an unknown id, 400 for a malformed one', async () => {
      const unknown = await asAdmin().post(`/admin/sellers/${UNKNOWN_ID}/approve`);
      expect([unknown.status, errorBody(unknown).error.code]).toEqual([404, 'SELLER_NOT_FOUND']);
      expect((await asAdmin().post('/admin/sellers/123/approve')).status).toBe(400);
    });
  });

  describe('reject → re-apply → approve', () => {
    it('the seller sees the reason, re-applies, and the approval clears it', async () => {
      const seller = await fx.createVerifiedSeller();
      const noReason = await asAdmin().post(`/admin/sellers/${seller.sellerId}/reject`, {});
      expect([noReason.status, errorBody(noReason).error.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect(
        (await asAdmin().post(`/admin/sellers/${seller.sellerId}/reject`, { reason: 'ab' })).status,
      ).toBe(400);

      const rejected = await asAdmin().post(`/admin/sellers/${seller.sellerId}/reject`, {
        reason: '  Missing documents ',
      });
      expect(detail(rejected)).toMatchObject({ status: 'rejected', rejectionReason: 'Missing documents' });

      const profile = await as(seller.accessToken).get('/seller/profile');
      expect(successBody<SellerProfileDto>(profile).data.rejectionReason).toBe('Missing documents');

      expect((await as(seller.accessToken).post('/seller/profile/reapply')).status).toBe(200);
      const back = detail(await asAdmin().post(`/admin/sellers/${seller.sellerId}/approve`));
      expect(back).toMatchObject({ status: 'approved', rejectionReason: null });
      expect(back.statusHistory.map((h) => [h.fromStatus, h.toStatus])).toEqual([
        ['pending_approval', 'approved'],
        ['rejected', 'pending_approval'],
        ['pending_approval', 'rejected'],
        [null, 'pending_approval'],
      ]);
      // reject only works from pending_approval
      const late = await asAdmin().post(`/admin/sellers/${seller.sellerId}/reject`, { reason: 'Too late' });
      expect([late.status, errorBody(late).error.code]).toEqual([409, 'SELLER_INVALID_STATUS_TRANSITION']);
    });
  });

  describe('suspend → reinstate', () => {
    it('suspend needs approved + a reason; publishes seller.suspended; login still works (Q-36)', async () => {
      const pending = await fx.createVerifiedSeller();
      const early = await asAdmin().post(`/admin/sellers/${pending.sellerId}/suspend`, {
        reason: 'Fake goods',
      });
      expect([early.status, errorBody(early).error.code]).toEqual([409, 'SELLER_INVALID_STATUS_TRANSITION']);

      const seller = await approved();
      const firstApprovedAt = detail(await asAdmin().get(`/admin/sellers/${seller.sellerId}`)).approvedAt;
      expect((await asAdmin().post(`/admin/sellers/${seller.sellerId}/suspend`, {})).status).toBe(400);
      const res = await asAdmin().post(`/admin/sellers/${seller.sellerId}/suspend`, { reason: 'Fake goods' });
      expect(detail(res).status).toBe('suspended');
      const login = await request(t.app)
        .post(`${API}/auth/login`)
        .send({ email: seller.email, password: PASSWORD });
      expect(login.status).toBe(200);

      // No body at all is fine for reinstate (the reason is optional).
      const reinstated = await asAdmin().post(`/admin/sellers/${seller.sellerId}/reinstate`);
      expect(reinstated.status).toBe(200);
      // approvedAt keeps the first approval.
      expect(detail(reinstated)).toMatchObject({ status: 'approved', approvedAt: firstApprovedAt });
      expect((await outboxEvents(seller.sellerId)).map((e) => [e.event_type, e.payload])).toEqual([
        [
          'seller.approved',
          { sellerId: seller.sellerId, userId: seller.userId, previousStatus: 'pending_approval' },
        ],
        ['seller.suspended', { sellerId: seller.sellerId, userId: seller.userId, reason: 'Fake goods' }],
        [
          'seller.approved',
          { sellerId: seller.sellerId, userId: seller.userId, previousStatus: 'suspended' },
        ],
      ]);
    });

    it('reinstate with a reason records it; reinstate from approved → 409', async () => {
      const seller = await approved();
      await asAdmin().post(`/admin/sellers/${seller.sellerId}/suspend`, { reason: 'Fake goods' });
      const res = await asAdmin().post(`/admin/sellers/${seller.sellerId}/reinstate`, {
        reason: 'Appeal accepted',
      });
      expect(detail(res).statusHistory[0]).toMatchObject({ toStatus: 'approved', reason: 'Appeal accepted' });
      expect((await asAdmin().post(`/admin/sellers/${seller.sellerId}/reinstate`)).status).toBe(409);
    });
  });

  describe('PUT /admin/sellers/:sellerId/commission-rate', () => {
    it('200: new rate + history (old/new/admin); the same rate in another spelling → 409', async () => {
      const seller = await fx.createVerifiedSeller();
      const res = await asAdmin().put(`/admin/sellers/${seller.sellerId}/commission-rate`, {
        commissionRate: '0.125',
      });
      expect(res.status).toBe(200);
      expect(detail(res)).toMatchObject({
        commissionRate: '0.1250',
        commissionHistory: [{ oldRate: '0.1000', newRate: '0.1250', changedByUserId: admin.userId }],
      });
      const same = await asAdmin().put(`/admin/sellers/${seller.sellerId}/commission-rate`, {
        commissionRate: '0.1250',
      });
      expect([same.status, errorBody(same).error.code]).toEqual([409, 'COMMISSION_RATE_UNCHANGED']);
    });

    it('400 for a bad rate, 404 for an unknown seller', async () => {
      const seller = await fx.createVerifiedSeller();
      for (const commissionRate of ['1.5', '0.12345', 0.2, '-0.1']) {
        const res = await asAdmin().put(`/admin/sellers/${seller.sellerId}/commission-rate`, {
          commissionRate,
        });
        expect([String(commissionRate), res.status]).toEqual([String(commissionRate), 400]);
      }
      const unknown = await asAdmin().put(`/admin/sellers/${UNKNOWN_ID}/commission-rate`, {
        commissionRate: '0.2',
      });
      expect([unknown.status, errorBody(unknown).error.code]).toEqual([404, 'SELLER_NOT_FOUND']);
    });
  });

  describe('GET / PUT /admin/settings/commission', () => {
    it('the default applies to sellers registered after the change only', async () => {
      const before = await fx.createVerifiedSeller();
      const res = await asAdmin().put('/admin/settings/commission', { defaultCommissionRate: '0.15' });
      expect(res.status).toBe(200);
      expect(successBody<CommissionSettingsDto>(res).data.defaultCommissionRate).toBe('0.1500');
      expect(
        successBody<CommissionSettingsDto>(await asAdmin().get('/admin/settings/commission')).data
          .defaultCommissionRate,
      ).toBe('0.1500');

      const after = await fx.createVerifiedSeller();
      expect(detail(await asAdmin().get(`/admin/sellers/${after.sellerId}`)).commissionRate).toBe('0.1500');
      expect(detail(await asAdmin().get(`/admin/sellers/${before.sellerId}`)).commissionRate).toBe('0.1000');

      expect((await asAdmin().put('/admin/settings/commission', { defaultCommissionRate: '2' })).status).toBe(
        400,
      );
      await asAdmin().put('/admin/settings/commission', { defaultCommissionRate: '0.1' });
    });
  });

  describe('GET /admin/sellers', () => {
    it('filters (status, businessName like, pickupGovernorateId), cursor pagination, emails', async () => {
      const tag = randomUUID().slice(0, 8);
      const giza = await fx.governorateId('EG-GZ');
      const a = await fx.createVerifiedSeller({ businessName: `Tag ${tag} A` });
      const b = await fx.createVerifiedSeller({ businessName: `Tag ${tag} B` });
      const c = await fx.createVerifiedSeller({
        businessName: `Tag ${tag} C`,
        pickupAddress: { governorateId: giza, city: 'Giza', area: 'Dokki', street: 'Tahrir', building: '1' },
      });
      await asAdmin().post(`/admin/sellers/${b.sellerId}/approve`);

      const page1 = await asAdmin().get(`/admin/sellers?businessName[like]=${tag}&limit=2`);
      expect(page1.status).toBe(200);
      const body1 = successBody<AdminSellerListItemDto[]>(page1);
      expect(body1.data.map((s) => s.id)).toEqual([c.sellerId, b.sellerId]);
      expect(body1.data[0]).toMatchObject({
        email: c.email,
        pickupGovernorateId: giza,
        commissionRate: '0.1000',
      });
      const meta = body1.meta as PageMeta;
      expect(meta.hasMore).toBe(true);
      const page2 = await asAdmin().get(
        `/admin/sellers?businessName[like]=${tag}&limit=2&cursor=${encodeURIComponent(meta.nextCursor ?? '')}`,
      );
      expect(successBody<AdminSellerListItemDto[]>(page2).data.map((s) => s.id)).toEqual([a.sellerId]);

      const approvedOnly = await asAdmin().get(
        `/admin/sellers?businessName[like]=${tag}&status[eq]=approved`,
      );
      expect(successBody<AdminSellerListItemDto[]>(approvedOnly).data.map((s) => s.id)).toEqual([b.sellerId]);
      const inGiza = await asAdmin().get(
        `/admin/sellers?businessName[like]=${tag}&pickupGovernorateId[eq]=${giza}`,
      );
      expect(successBody<AdminSellerListItemDto[]>(inGiza).data.map((s) => s.id)).toEqual([c.sellerId]);
      const oldestFirst = await asAdmin().get(`/admin/sellers?businessName[like]=${tag}&sort=createdAt`);
      expect(successBody<AdminSellerListItemDto[]>(oldestFirst).data.map((s) => s.id)).toEqual([
        a.sellerId,
        b.sellerId,
        c.sellerId,
      ]);
    });

    it('400 INVALID_QUERY for an unknown field, operator or enum value', async () => {
      for (const query of ['email[eq]=x', 'status[like]=app', 'status[eq]=banned', 'sort=businessName']) {
        const res = await asAdmin().get(`/admin/sellers?${query}`);
        expect([query, res.status, errorBody(res).error.code]).toEqual([query, 400, 'INVALID_QUERY']);
      }
    });
  });

  describe('GET /admin/sellers/:sellerId', () => {
    it('200 with the pickup address and both histories; 404 for an unknown id', async () => {
      const seller = await fx.createVerifiedSeller();
      const res = await asAdmin().get(`/admin/sellers/${seller.sellerId}`);
      expect(detail(res)).toMatchObject({
        id: seller.sellerId,
        pickupAddress: { governorateId: cairoId, city: 'Cairo', landmark: null },
        rejectionReason: null,
        emailVerified: true,
        statusHistory: [{ fromStatus: null, toStatus: 'pending_approval', actorUserId: seller.userId }],
        commissionHistory: [],
      });
      const unknown = await asAdmin().get(`/admin/sellers/${UNKNOWN_ID}`);
      expect([unknown.status, errorBody(unknown).error.code]).toEqual([404, 'SELLER_NOT_FOUND']);
    });
  });
});
