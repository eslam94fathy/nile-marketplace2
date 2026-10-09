import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IDeliveryReferenceService } from '../../src/app/delivery';
import { GOVERNORATES_CACHE_KEY } from '../../src/app/delivery/constants';
import {
  type DeliverySettingsDto,
  type GovernorateDto,
} from '../../src/app/delivery/dto/delivery-response.dto';
import { TOKENS } from '../../src/lib/di';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

/* Spec 11 §4.1 + the reference-data part of §4.3 over HTTP, and the §2 public API. */
describe('delivery reference data endpoints', () => {
  let t: TestApp;
  let adminToken: string;
  let customerToken: string;
  let cairo: GovernorateDto;

  const as = (token: string | undefined) => {
    const withAuth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
    return {
      get: (path: string) => withAuth(request(t.app).get(`${API}${path}`)),
      patch: (path: string, body?: object) => withAuth(request(t.app).patch(`${API}${path}`)).send(body),
      put: (path: string, body?: object) => withAuth(request(t.app).put(`${API}${path}`)).send(body),
    };
  };
  const asAdmin = () => as(adminToken);
  const publicList = async () => successBody<GovernorateDto[]>(await as(undefined).get('/governorates')).data;

  beforeAll(async () => {
    t = await startTestApp();
    adminToken = await signTestAccessToken({ role: 'admin' });
    customerToken = await signTestAccessToken({ role: 'customer' });
    const found = (await publicList()).find((g) => g.code === 'EG-C');
    if (!found) throw new Error('Cairo is not seeded');
    cairo = found;
  });
  afterAll(async () => {
    await t.close();
  });

  describe('GET /governorates (public)', () => {
    it('200: all 27, ordered by name, none deliverable until an admin sets fees', async () => {
      const res = await as(undefined).get('/governorates');
      expect(res.status).toBe(200);
      const list = successBody<GovernorateDto[]>(res).data;
      expect(list).toHaveLength(27);
      expect(list.map((g) => g.name)).toEqual([...list.map((g) => g.name)].sort());
      expect(Object.keys(cairo).sort()).toEqual(['code', 'deliveryFee', 'id', 'isDeliverable', 'name']);
      // Seeded without fees (DE-2), except the ones this file changes later.
      expect(
        list.filter((g) => g.code !== 'EG-C').every((g) => g.deliveryFee === null && !g.isDeliverable),
      ).toBe(true);
    });

    it('is served from the Redis cache after the first read', async () => {
      await as(undefined).get('/governorates');
      expect(await t.infra.cache.get(GOVERNORATES_CACHE_KEY)).not.toBeNull();
    });
  });

  describe('authz (every admin route)', () => {
    const routes: [string, 'get' | 'patch' | 'put'][] = [
      ['/admin/governorates', 'get'],
      [`/admin/governorates/${UNKNOWN_ID}`, 'patch'],
      ['/admin/settings/delivery', 'get'],
      ['/admin/settings/delivery', 'put'],
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

  describe('GET /admin/governorates', () => {
    it('200: the same list as the public endpoint', async () => {
      const res = await asAdmin().get('/admin/governorates');
      expect(res.status).toBe(200);
      expect(successBody<GovernorateDto[]>(res).data).toEqual(await publicList());
    });
  });

  describe('PATCH /admin/governorates/:governorateId', () => {
    it('200: sets the fee (normalised to 2 decimals) and the next public read shows it', async () => {
      await publicList(); // warm the cache
      const res = await asAdmin().patch(`/admin/governorates/${cairo.id}`, { deliveryFee: '45.5' });
      expect(res.status).toBe(200);
      expect(successBody<GovernorateDto>(res).data).toEqual({
        ...cairo,
        deliveryFee: '45.50',
        isDeliverable: true,
      });
      expect((await publicList()).find((g) => g.id === cairo.id)).toMatchObject({
        deliveryFee: '45.50',
        isDeliverable: true,
      });
    });

    it('200: null makes it non-deliverable again', async () => {
      const res = await asAdmin().patch(`/admin/governorates/${cairo.id}`, { deliveryFee: null });
      expect(successBody<GovernorateDto>(res).data).toMatchObject({
        deliveryFee: null,
        isDeliverable: false,
      });
      expect((await publicList()).find((g) => g.id === cairo.id)?.isDeliverable).toBe(false);
    });

    it('400 VALIDATION_FAILED for a bad fee, a missing fee, or an unknown field', async () => {
      for (const body of [
        { deliveryFee: '-1' },
        { deliveryFee: '1.234' },
        { deliveryFee: 12.5 },
        {},
        { deliveryFee: '10', currency: 'USD' },
      ]) {
        const res = await asAdmin().patch(`/admin/governorates/${cairo.id}`, body);
        expect([JSON.stringify(body), res.status, errorBody(res).error.code]).toEqual([
          JSON.stringify(body),
          400,
          'VALIDATION_FAILED',
        ]);
      }
    });

    it('400 for a malformed id, 404 GOVERNORATE_NOT_FOUND for an unknown one', async () => {
      const malformed = await asAdmin().patch('/admin/governorates/cairo', { deliveryFee: '10' });
      expect([malformed.status, errorBody(malformed).error.code]).toEqual([400, 'VALIDATION_FAILED']);
      const unknown = await asAdmin().patch(`/admin/governorates/${UNKNOWN_ID}`, { deliveryFee: '10' });
      expect([unknown.status, errorBody(unknown).error.code]).toEqual([404, 'GOVERNORATE_NOT_FOUND']);
    });
  });

  describe('GET / PUT /admin/settings/delivery', () => {
    it('200: the seeded rate, then a change (normalised to 4 decimals)', async () => {
      const before = await asAdmin().get('/admin/settings/delivery');
      expect(before.status).toBe(200);
      expect(successBody<DeliverySettingsDto>(before).data.agentFeeShareRate).toBe('0.7000');

      const res = await asAdmin().put('/admin/settings/delivery', { agentFeeShareRate: '0.65' });
      expect(res.status).toBe(200);
      const data = successBody<DeliverySettingsDto>(res).data;
      expect(data.agentFeeShareRate).toBe('0.6500');
      expect(new Date(data.updatedAt).toISOString()).toBe(data.updatedAt);
      expect(successBody<DeliverySettingsDto>(await asAdmin().get('/admin/settings/delivery')).data).toEqual(
        data,
      );
    });

    it('400 VALIDATION_FAILED for a rate outside 0..1, too many decimals, or a missing rate', async () => {
      for (const body of [
        { agentFeeShareRate: '1.5' },
        { agentFeeShareRate: '0.12345' },
        { agentFeeShareRate: 0.5 },
        {},
      ]) {
        const res = await asAdmin().put('/admin/settings/delivery', body);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      }
    });
  });

  describe('public API (spec 11 §2)', () => {
    it('getGovernorateFees and getAgentFeeShareRate read the current values', async () => {
      const api = t.container.resolve<IDeliveryReferenceService>(TOKENS.DeliveryReferenceService);
      await asAdmin().patch(`/admin/governorates/${cairo.id}`, { deliveryFee: '30' });
      await asAdmin().put('/admin/settings/delivery', { agentFeeShareRate: '0.7' });

      expect(await api.getGovernorateFees([cairo.id, UNKNOWN_ID])).toEqual([
        { id: cairo.id, name: 'Cairo', deliveryFee: '30.00' },
      ]);
      expect(await api.getAgentFeeShareRate()).toBe('0.7000');
    });
  });
});
