import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DashboardDto } from '../../src/app/backoffice/dto/dashboard.dto';
import { type IOrderingDirectory } from '../../src/app/ordering';
import { TOKENS } from '../../src/lib/di';
import { successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { orderFixtures } from '../helpers/order-fixtures';
import { startTestApp, type TestApp } from '../helpers/test-app';

const WINDOW = { gmvDays: 30, recentDays: 7, topSellers: 10 };

/*
 * Spec 20 §3.2 (BO-7, BO-12, BO-13, BO-20…BO-22): the admin dashboard. This file's database starts
 * empty, so every figure is exact.
 */
describe('admin dashboard', () => {
  let t: TestApp;
  let fx: ReturnType<typeof orderFixtures>;
  let adminToken: string;
  const knex = () => t.infra.db.knex;
  const ordering = () => t.container.resolve<IOrderingDirectory>(TOKENS.OrderingDirectory);

  /** A seller order with commission 0 (so seller_net = subtotal, chk_seller_orders_net) and any status. */
  const sellerOrder = (
    orderId: string,
    sellerId: string,
    subtotal: string,
    overrides: Record<string, unknown> = {},
  ) =>
    fx.insertSellerOrder(orderId, sellerId, {
      subtotal,
      commission: '0.00',
      seller_net: subtotal,
      ...overrides,
    });
  const delivered = (at: string) => ({ status: 'delivered', delivered_at: new Date(at) });
  const cancelled = { status: 'cancelled', cancel_reason: 'seller_cancelled', cancelled_at: new Date() };

  beforeAll(async () => {
    t = await startTestApp();
    fx = orderFixtures(knex());
    const adminId = await fx.insertUser('admin');
    adminToken = await signTestAccessToken({ sub: adminId, role: 'admin' });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('ordering figures on Cairo business days', () => {
    it('summer (UTC+3): windows end today, placed GMV skips cancelled, top sellers by delivered GMV', async () => {
      const { customerId } = await fx.insertCustomer();
      const x = (await fx.insertSeller()).sellerId;
      const y = (await fx.insertSeller()).sellerId;
      // 2026-07-16 00:10 Cairo: today, though still 2026-07-15 in UTC.
      const a = await fx.insertOrder(customerId, { placed_at: new Date('2026-07-15T21:10:00Z') });
      await sellerOrder(a, x, '100.00');
      // 2026-07-15 23:50 Cairo: yesterday. The cancelled seller order leaves the placed GMV.
      const b = await fx.insertOrder(customerId, { placed_at: new Date('2026-07-15T20:50:00Z') });
      await sellerOrder(b, x, '60.00', { status: 'accepted' });
      await sellerOrder(b, y, '40.00', cancelled);
      // Placed 2026-07-01, delivered either side of Cairo midnight.
      const c = await fx.insertOrder(customerId, { placed_at: new Date('2026-07-01T10:00:00Z') });
      await sellerOrder(c, x, '70.00', delivered('2026-07-15T21:05:00Z'));
      await sellerOrder(c, y, '30.00', delivered('2026-07-15T20:55:00Z'));
      // Delivered before the 30-day window (2026-06-17 … 2026-07-16).
      const d = await fx.insertOrder(customerId, { placed_at: new Date('2026-05-20T10:00:00Z') });
      await sellerOrder(d, y, '999.00', delivered('2026-06-01T10:00:00Z'));

      const stats = await ordering().getDashboardStats({ now: new Date('2026-07-15T21:30:00Z'), ...WINDOW });
      expect(stats.placedToday).toBe(1);
      expect(stats.placedRecent).toBe(2);
      expect(stats.gmv).toHaveLength(30);
      expect(stats.gmv[0]?.day).toBe('2026-06-17');
      const day = (d: string) => stats.gmv.find((g) => g.day === d);
      expect(stats.gmv.at(-1)).toEqual({ day: '2026-07-16', placed: '100.00', delivered: '70.00' });
      expect(day('2026-07-15')).toEqual({ day: '2026-07-15', placed: '60.00', delivered: '30.00' });
      expect(day('2026-07-01')).toEqual({ day: '2026-07-01', placed: '100.00', delivered: '0.00' });
      expect(day('2026-07-02')).toEqual({ day: '2026-07-02', placed: '0.00', delivered: '0.00' });
      expect(stats.topSellers).toEqual([
        { sellerId: x, deliveredGmv: '70.00' },
        { sellerId: y, deliveredGmv: '30.00' },
      ]);
    });

    it('winter (UTC+2): the boundary moves with the offset', async () => {
      const { customerId } = await fx.insertCustomer();
      const x = (await fx.insertSeller()).sellerId;
      // 2026-01-16 00:10 Cairo, and 2026-01-15 23:50 Cairo (00:50 under a summer offset).
      const today = await fx.insertOrder(customerId, { placed_at: new Date('2026-01-15T22:10:00Z') });
      await sellerOrder(today, x, '25.00');
      const yesterday = await fx.insertOrder(customerId, { placed_at: new Date('2026-01-15T21:50:00Z') });
      await sellerOrder(yesterday, x, '35.00');

      const stats = await ordering().getDashboardStats({ now: new Date('2026-01-15T22:30:00Z'), ...WINDOW });
      expect(stats.placedToday).toBe(1);
      expect(stats.placedRecent).toBe(2);
      expect(stats.gmv.slice(-2)).toEqual([
        { day: '2026-01-15', placed: '35.00', delivered: '0.00' },
        { day: '2026-01-16', placed: '25.00', delivered: '0.00' },
      ]);
    });
  });

  describe('GET /admin/dashboard', () => {
    it('composes every block, then serves the cached value until it expires', async () => {
      await knex()('seller_orders').del();
      await knex()('orders').del();
      const { customerId } = await fx.insertCustomer();
      const seller = await fx.insertSeller();
      await fx.insertSeller('pending_approval');
      await fx.insertSeller('pending_approval');
      const placed = await fx.insertOrder(customerId, { placed_at: new Date() });
      await sellerOrder(placed, seller.sellerId, '120.00');
      await sellerOrder(
        placed,
        (await fx.insertSeller()).sellerId,
        '80.00',
        delivered(new Date().toISOString()),
      );
      await knex()('finance_accounts').insert([
        { account_type: 'agent_cod_cash', owner_id: seller.userId, balance: '120.50' },
        { account_type: 'agent_cod_cash', owner_id: customerId, balance: '30.00' },
        { account_type: 'seller_payable', owner_id: seller.sellerId, balance: '200.00' },
      ]);

      const res = await request(t.app)
        .get(`${API}/admin/dashboard`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const dashboard = successBody<DashboardDto>(res).data;
      expect(dashboard.orders).toEqual({
        byStatus: {
          pending_payment: 0,
          placed: 1,
          accepted: 0,
          ready_for_pickup: 0,
          picked_up: 0,
          out_for_delivery: 0,
          delivery_failed: 0,
          returning_to_seller: 0,
        },
        placedToday: 1,
        placedLast7Days: 1,
      });
      expect(dashboard.gmv).toHaveLength(30);
      expect(dashboard.gmv.at(-1)).toMatchObject({ placed: '200.00', delivered: '80.00' });
      expect(dashboard.topSellers).toEqual([
        {
          sellerId: expect.any(String) as unknown,
          businessName: expect.any(String) as unknown,
          deliveredGmv: '80.00',
        },
      ]);
      expect(dashboard.sellers).toEqual({ pendingApproval: 2 });
      expect(dashboard.support).toEqual({ open: 0, awaitingAdmin: 0, slaBreached: 0 });
      expect(dashboard.finance).toEqual({
        codOutstanding: '150.50',
        sellerPayable: '200.00',
        agentFeePayable: '0.00',
      });
      expect(dashboard.delivery).toEqual({ awaitingAssignment: 0, outForDelivery: 0 });

      // Cached: a new pending seller shows only once the value is gone (no invalidation, spec 20 §3.2).
      await fx.insertSeller('pending_approval');
      const again = await request(t.app)
        .get(`${API}/admin/dashboard`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(successBody<DashboardDto>(again).data).toEqual(dashboard);
      await t.infra.cache.delete('v1:backoffice:dashboard');
      const fresh = await request(t.app)
        .get(`${API}/admin/dashboard`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(successBody<DashboardDto>(fresh).data.sellers).toEqual({ pendingApproval: 3 });
    });

    it('admins only', async () => {
      const seller = await fx.insertSeller();
      const token = await signTestAccessToken({ sub: seller.userId, role: 'seller' });
      const res = await request(t.app).get(`${API}/admin/dashboard`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect((await request(t.app).get(`${API}/admin/dashboard`)).status).toBe(401);
    });
  });
});
