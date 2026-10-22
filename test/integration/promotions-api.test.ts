import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CategoryTreeService } from '../../src/app/catalog/service/category-tree.service';
import { type IPromotions, type QuoteLine } from '../../src/app/promotions';
import { TOKENS } from '../../src/lib/di';
import { AppError } from '../../src/lib/error';
import { Money } from '../../src/lib/money';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

interface CouponBody {
  id: string;
  code: string;
  funding: string;
  sellerId: string | null;
  discountType: string;
  discountValue: string;
  scope: string;
  scopeSellerId: string | null;
  scopeCategoryId: string | null;
  status: string;
  displayStatus: string;
  redemptionCount: number;
  adminBlocked: boolean;
  adminBlockReason: string | null;
  redemptions?: { orderId: string; status: string }[];
}

const DAY = 86_400_000;
const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
let codes = 0;
const nextCode = () => `C${Date.now().toString(36)}-${++codes}`.toUpperCase();

/* Spec 19 §3, §4 (PR-10…PR-20): coupon management, quote, redeem and release. */
describe('promotions', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let adminToken: string;
  let adminUserId: string;
  let promotions: IPromotions;
  const knex = () => t.infra.db.knex;

  const call = (token: string, method: 'get' | 'post' | 'patch', path: string, body?: object) =>
    request(t.app)[method](`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body);
  const body = (overrides: Record<string, unknown> = {}) => ({
    code: nextCode(),
    discountType: 'percent',
    discountValue: '0.10',
    minItemsSubtotal: '0.00',
    scope: 'seller',
    startsAt: iso(-DAY),
    endsAt: iso(DAY),
    perCustomerLimit: 1,
    ...overrides,
  });
  const seller = async (status = 'approved') => {
    const { sellerId, userId } = await api.fx.insertSeller(status);
    return { sellerId, userId, token: await signTestAccessToken({ sub: userId, role: 'seller' }) };
  };
  /** Inserted by SQL, so the cached tree is dropped (as an admin write does after commit). */
  const newCategory = async (parentId: string | null = null) => {
    const id = await api.fx.insertCategory({ parentId, depth: parentId ? 2 : 1 });
    await t.container.resolve<CategoryTreeService>(TOKENS.CategoryTreeService).invalidate();
    return id;
  };
  const createAdminCoupon = async (overrides: Record<string, unknown> = {}) => {
    const res = await call(adminToken, 'post', '/admin/coupons', body({ scope: 'all', ...overrides }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return successBody<CouponBody>(res).data;
  };

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
    adminUserId = await api.fx.insertUser('admin');
    adminToken = await signTestAccessToken({ sub: adminUserId, role: 'admin' });
    promotions = t.container.resolve<IPromotions>(TOKENS.Promotions);
  });
  afterAll(async () => {
    await t.close();
  });

  describe('seller coupons (§4.2)', () => {
    it('creates a coupon for its own products, upper-cases the code, lists and reads it', async () => {
      const s = await seller();
      const code = `own-${randomUUID().slice(0, 8)}`;
      const res = await call(s.token, 'post', '/seller/coupons', body({ code }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const coupon = successBody<CouponBody>(res).data;
      expect(coupon).toMatchObject({
        code: code.toUpperCase(),
        funding: 'seller',
        sellerId: s.sellerId,
        scope: 'seller',
        scopeSellerId: s.sellerId,
        discountValue: '0.1000',
        status: 'active',
        displayStatus: 'active',
        redemptionCount: 0,
        adminBlocked: false,
      });
      const list = await call(s.token, 'get', '/seller/coupons');
      expect(successBody<CouponBody[]>(list).data.map((c) => c.id)).toEqual([coupon.id]);
      expect((await call(s.token, 'get', `/seller/coupons/${coupon.id}`)).status).toBe(200);

      const other = await seller();
      const hidden = await call(other.token, 'get', `/seller/coupons/${coupon.id}`);
      expect(hidden.status).toBe(404);
      expect(errorBody(hidden).error.code).toBe('COUPON_NOT_FOUND');
      expect(
        (await call(other.token, 'patch', `/seller/coupons/${coupon.id}`, { status: 'inactive' })).status,
      ).toBe(404);
    });

    it('rejects bad bodies: unknown fields 400, cross-field rules 422, a taken code 409', async () => {
      const s = await seller();
      const unknown = await call(s.token, 'post', '/seller/coupons', body({ scopeSellerId: s.sellerId }));
      expect(unknown.status).toBe(400);
      expect((await call(s.token, 'post', '/seller/coupons', body({ scope: 'all' }))).status).toBe(400);
      expect((await call(s.token, 'post', '/seller/coupons', body({ code: 'AB!' }))).status).toBe(400);

      const invalid = await call(
        s.token,
        'post',
        '/seller/coupons',
        body({ discountValue: '0.95', endsAt: iso(-1) }),
      );
      expect(invalid.status).toBe(422);
      expect(errorBody(invalid).error.code).toBe('COUPON_INVALID');
      expect(errorBody(invalid).error.details?.map((d) => d.field)).toEqual(['discountValue', 'endsAt']);

      const noCategory = await call(
        s.token,
        'post',
        '/seller/coupons',
        body({ scope: 'category', scopeCategoryId: UNKNOWN_ID }),
      );
      expect(noCategory.status).toBe(422);
      expect(errorBody(noCategory).error.code).toBe('CATEGORY_NOT_FOUND');

      const code = nextCode();
      expect((await call(s.token, 'post', '/seller/coupons', body({ code }))).status).toBe(201);
      const taken = await call(s.token, 'post', '/seller/coupons', body({ code: code.toLowerCase() }));
      expect(taken.status).toBe(409);
      expect(errorBody(taken).error.code).toBe('COUPON_CODE_TAKEN');
    });

    it('needs an approved seller to write, any status to read; customers and admins are refused', async () => {
      const s = await seller();
      const coupon = successBody<CouponBody>(await call(s.token, 'post', '/seller/coupons', body())).data;
      await knex()('sellers').where({ id: s.sellerId }).update({ status: 'suspended' });
      const refused = await call(s.token, 'post', '/seller/coupons', body());
      expect(refused.status).toBe(403);
      expect(errorBody(refused).error.code).toBe('SELLER_NOT_APPROVED');
      expect(
        (await call(s.token, 'patch', `/seller/coupons/${coupon.id}`, { status: 'inactive' })).status,
      ).toBe(403);
      expect((await call(s.token, 'get', `/seller/coupons/${coupon.id}`)).status).toBe(200);

      const buyer = await api.customer();
      expect((await call(buyer.token, 'get', '/seller/coupons')).status).toBe(403);
      expect((await call(adminToken, 'post', '/seller/coupons', body())).status).toBe(403);
      expect((await request(t.app).get(`${API}/seller/coupons`)).status).toBe(401);
    });

    it('a category coupon covers the seller and the category; a scope change drops the old ids', async () => {
      const s = await seller();
      const categoryId = await newCategory();
      const res = await call(
        s.token,
        'post',
        '/seller/coupons',
        body({ scope: 'category', scopeCategoryId: categoryId }),
      );
      expect(successBody<CouponBody>(res).data).toMatchObject({
        scopeSellerId: s.sellerId,
        scopeCategoryId: categoryId,
      });
      const id = successBody<CouponBody>(res).data.id;
      const back = await call(s.token, 'patch', `/seller/coupons/${id}`, { scope: 'seller' });
      expect(successBody<CouponBody>(back).data).toMatchObject({ scope: 'seller', scopeCategoryId: null });
      expect((await call(s.token, 'patch', `/seller/coupons/${id}`, {})).status).toBe(400);
    });
  });

  describe('admin coupons (§4.3)', () => {
    it('creates a platform coupon with an audit row; checks the referenced seller', async () => {
      const coupon = await createAdminCoupon({ discountType: 'fixed', discountValue: '25.5' });
      expect(coupon).toMatchObject({
        funding: 'platform',
        sellerId: null,
        scope: 'all',
        discountValue: '25.50',
      });
      const [audit] = await knex()('admin_audit_log')
        .where({ target_type: 'coupon', target_id: coupon.id })
        .select<{ action: string; actor_user_id: string }[]>('action', 'actor_user_id');
      expect(audit).toEqual({ action: 'coupon.created', actor_user_id: adminUserId });

      const unknownSeller = await call(
        adminToken,
        'post',
        '/admin/coupons',
        body({ scope: 'seller', scopeSellerId: UNKNOWN_ID }),
      );
      expect(unknownSeller.status).toBe(422);
      expect(errorBody(unknownSeller).error.code).toBe('SELLER_NOT_FOUND');
      const s = await seller();
      expect(
        (
          await call(
            adminToken,
            'post',
            '/admin/coupons',
            body({ scope: 'seller', scopeSellerId: s.sellerId }),
          )
        ).status,
      ).toBe(201);
      const missingId = await call(adminToken, 'post', '/admin/coupons', body({ scope: 'seller' }));
      expect(errorBody(missingId).error.code).toBe('COUPON_INVALID');
    });

    it('lists with filters, reads the detail, updates platform coupons only', async () => {
      const coupon = await createAdminCoupon();
      const byCode = await call(adminToken, 'get', `/admin/coupons?code[eq]=${coupon.code}`);
      expect(successBody<CouponBody[]>(byCode).data.map((c) => c.id)).toEqual([coupon.id]);
      const detail = await call(adminToken, 'get', `/admin/coupons/${coupon.id}`);
      expect(successBody<CouponBody>(detail).data.redemptions).toEqual([]);
      expect((await call(adminToken, 'get', `/admin/coupons/${UNKNOWN_ID}`)).status).toBe(404);

      const updated = await call(adminToken, 'patch', `/admin/coupons/${coupon.id}`, {
        discountValue: '0.2',
      });
      expect(successBody<CouponBody>(updated).data.discountValue).toBe('0.2000');
      const actions = await knex()('admin_audit_log')
        .where({ target_type: 'coupon', target_id: coupon.id })
        .orderBy('created_at')
        .pluck('action');
      expect(actions).toEqual(['coupon.created', 'coupon.updated']);

      const s = await seller();
      const theirs = successBody<CouponBody>(await call(s.token, 'post', '/seller/coupons', body())).data;
      const refused = await call(adminToken, 'patch', `/admin/coupons/${theirs.id}`, { status: 'inactive' });
      expect(refused.status).toBe(409);
      expect(errorBody(refused).error.code).toBe('COUPON_SELLER_FUNDED');
    });

    it('locks every field but endsAt, globalLimit and status after the first redemption (PR-8)', async () => {
      const coupon = await createAdminCoupon({ globalLimit: 10 });
      await knex()('coupons')
        .where({ id: coupon.id })
        .update({ redemption_count: 3, first_redeemed_at: new Date() });
      const locked = await call(adminToken, 'patch', `/admin/coupons/${coupon.id}`, {
        minItemsSubtotal: '10.00',
      });
      expect(locked.status).toBe(409);
      expect(errorBody(locked).error.code).toBe('COUPON_LOCKED');
      // The same value is no change.
      expect(
        (await call(adminToken, 'patch', `/admin/coupons/${coupon.id}`, { minItemsSubtotal: '0' })).status,
      ).toBe(200);
      expect(
        (
          await call(adminToken, 'patch', `/admin/coupons/${coupon.id}`, {
            endsAt: iso(2 * DAY),
            status: 'inactive',
          })
        ).status,
      ).toBe(200);
      const below = await call(adminToken, 'patch', `/admin/coupons/${coupon.id}`, { globalLimit: 2 });
      expect(below.status).toBe(422);
      expect(errorBody(below).error.code).toBe('COUPON_INVALID');
    });

    it('blocks a seller coupon: inactive, event and audit; the seller cannot activate it until unblocked (PR-20)', async () => {
      const s = await seller();
      const coupon = successBody<CouponBody>(await call(s.token, 'post', '/seller/coupons', body())).data;
      const blocked = await call(adminToken, 'post', `/admin/coupons/${coupon.id}/block`, {
        reason: 'Abuse',
      });
      expect(blocked.status).toBe(200);
      expect(successBody<CouponBody>(blocked).data).toMatchObject({
        status: 'inactive',
        adminBlocked: true,
        adminBlockReason: 'Abuse',
      });
      expect(await api.eventsOf('coupon.blocked', coupon.id)).toEqual([
        { couponId: coupon.id, sellerId: s.sellerId, at: expect.any(String) as unknown },
      ]);
      const [audit] = await knex()('admin_audit_log')
        .where({ target_type: 'coupon', target_id: coupon.id })
        .select<{ action: string; reason: string }[]>('action', 'reason');
      expect(audit).toEqual({ action: 'coupon.blocked', reason: 'Abuse' });

      expect(
        (await call(adminToken, 'post', `/admin/coupons/${coupon.id}/block`, { reason: 'Again' })).status,
      ).toBe(409);
      const activate = await call(s.token, 'patch', `/seller/coupons/${coupon.id}`, { status: 'active' });
      expect(activate.status).toBe(409);
      expect(errorBody(activate).error.code).toBe('COUPON_BLOCKED');
      expect(
        (await call(s.token, 'patch', `/seller/coupons/${coupon.id}`, { minItemsSubtotal: '50.00' })).status,
      ).toBe(200);

      const unblocked = await call(adminToken, 'post', `/admin/coupons/${coupon.id}/unblock`);
      expect(successBody<CouponBody>(unblocked).data).toMatchObject({
        status: 'inactive',
        adminBlocked: false,
      });
      expect((await call(adminToken, 'post', `/admin/coupons/${coupon.id}/unblock`)).status).toBe(409);
      expect(
        (await call(s.token, 'patch', `/seller/coupons/${coupon.id}`, { status: 'active' })).status,
      ).toBe(200);

      const platform = await createAdminCoupon();
      const invalid = await call(adminToken, 'post', `/admin/coupons/${platform.id}/block`, {
        reason: 'Abuse',
      });
      expect(errorBody(invalid).error.code).toBe('COUPON_BLOCK_INVALID_STATUS');
      expect(
        (await call(adminToken, 'post', `/admin/coupons/${platform.id}/block`, { reason: 'x' })).status,
      ).toBe(400);
    });
  });

  describe('quote, redeem and release (§3.1, UC-PR-2, UC-PR-3)', () => {
    const line = (lineTotal: string, sellerId: string, categoryId: string = randomUUID()): QuoteLine => ({
      variantId: randomUUID(),
      productId: randomUUID(),
      sellerId,
      categoryId,
      lineTotal: Money.of(lineTotal),
    });
    const quoteError = async (code: string, customerId: string, lines: QuoteLine[]) => {
      try {
        await promotions.quote(code, customerId, lines);
      } catch (error) {
        if (error instanceof AppError) return error.code;
        throw error;
      }
      return 'none';
    };
    const redeem = (couponId: string, customerId: string, orderId: string) =>
      knex().transaction((trx) =>
        promotions.redeem({ couponId, customerId, orderId, discountTotal: Money.of('10.00') }, trx),
      );

    it('quotes a valid code (lower-case accepted) with exact shares', async () => {
      const coupon = await createAdminCoupon({ discountValue: '0.10' });
      const s = await seller();
      const buyer = await api.customer();
      const quote = await promotions.quote(coupon.code.toLowerCase(), buyer.customerId, [
        line('100.00', s.sellerId),
        line('33.35', s.sellerId),
      ]);
      expect(quote).toMatchObject({ couponId: coupon.id, funding: 'platform', sellerId: null });
      expect(quote.discountTotal.toString()).toBe('13.34');
      expect(quote.lines.map((l) => l.discount.toString())).toEqual(['10.00', '3.34']);
    });

    it('answers the §3.1 codes in order', async () => {
      const s = await seller();
      const buyer = await api.customer();
      const lines = [line('100.00', s.sellerId)];
      expect(await quoteError('NO-SUCH-CODE', buyer.customerId, lines)).toBe('COUPON_NOT_FOUND');
      const inactive = await createAdminCoupon();
      await knex()('coupons').where({ id: inactive.id }).update({ status: 'inactive' });
      expect(await quoteError(inactive.code, buyer.customerId, lines)).toBe('COUPON_INACTIVE');
      const later = await createAdminCoupon({ startsAt: iso(DAY), endsAt: iso(2 * DAY) });
      expect(await quoteError(later.code, buyer.customerId, lines)).toBe('COUPON_NOT_ACTIVE_YET');
      const over = await createAdminCoupon();
      await knex()('coupons')
        .where({ id: over.id })
        .update({ starts_at: new Date(Date.now() - 2 * DAY), ends_at: new Date(Date.now() - 1000) });
      expect(await quoteError(over.code, buyer.customerId, lines)).toBe('COUPON_EXPIRED');

      const suspended = await seller();
      const theirs = successBody<CouponBody>(
        await call(suspended.token, 'post', '/seller/coupons', body()),
      ).data;
      await knex()('sellers').where({ id: suspended.sellerId }).update({ status: 'suspended' });
      expect(await quoteError(theirs.code, buyer.customerId, [line('100.00', suspended.sellerId)])).toBe(
        'COUPON_INACTIVE',
      );

      const used = await createAdminCoupon({ globalLimit: 1 });
      await knex()('coupons')
        .where({ id: used.id })
        .update({ redemption_count: 1, first_redeemed_at: new Date() });
      expect(await quoteError(used.code, buyer.customerId, lines)).toBe('COUPON_LIMIT_REACHED');

      const once = await createAdminCoupon();
      const chain = await api.fx.insertOrderChain();
      await redeem(once.id, chain.customerId, chain.orderId);
      expect(await quoteError(once.code, chain.customerId, lines)).toBe('COUPON_CUSTOMER_LIMIT_REACHED');

      const elsewhere = await createAdminCoupon({
        scope: 'seller',
        scopeSellerId: (await seller()).sellerId,
      });
      expect(await quoteError(elsewhere.code, buyer.customerId, lines)).toBe('COUPON_NOT_APPLICABLE');
      const big = await createAdminCoupon({ minItemsSubtotal: '150.00' });
      expect(await quoteError(big.code, buyer.customerId, lines)).toBe('COUPON_MIN_SUBTOTAL_NOT_MET');
    });

    it('a category coupon covers the whole subtree', async () => {
      const root = await newCategory();
      const child = await newCategory(root);
      const coupon = await createAdminCoupon({ scope: 'category', scopeCategoryId: root });
      const s = await seller();
      const buyer = await api.customer();
      const quote = await promotions.quote(coupon.code, buyer.customerId, [
        line('100.00', s.sellerId, child),
        line('100.00', s.sellerId),
      ]);
      expect(quote.lines.map((l) => l.discount.toString())).toEqual(['10.00', '0.00']);
    });

    it('a global limit lets exactly that many parallel redemptions through', async () => {
      const coupon = await createAdminCoupon({ globalLimit: 3 });
      const chains = await Promise.all(Array.from({ length: 6 }, () => api.fx.insertOrderChain()));
      const results = await Promise.allSettled(chains.map((c) => redeem(coupon.id, c.customerId, c.orderId)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      for (const r of results) {
        if (r.status === 'rejected') expect((r.reason as AppError).code).toBe('COUPON_LIMIT_REACHED');
      }
      const row = await knex()('coupons')
        .where({ id: coupon.id })
        .first<{ redemption_count: number; first_redeemed_at: Date | null }>(
          'redemption_count',
          'first_redeemed_at',
        );
      expect(row.redemption_count).toBe(3);
      expect(row.first_redeemed_at).not.toBeNull();
    });

    it('the per-customer limit holds in redeem; release gives the use back once', async () => {
      const coupon = await createAdminCoupon({ perCustomerLimit: 1 });
      const chain = await api.fx.insertOrderChain();
      await redeem(coupon.id, chain.customerId, chain.orderId);
      const second = await api.fx.insertOrder(chain.customerId);
      await expect(redeem(coupon.id, chain.customerId, second)).rejects.toMatchObject({
        code: 'COUPON_CUSTOMER_LIMIT_REACHED',
      });

      await knex().transaction((trx) => promotions.release(chain.orderId, trx));
      await knex().transaction((trx) => promotions.release(chain.orderId, trx)); // no-op
      await knex().transaction((trx) => promotions.release(randomUUID(), trx)); // none: no-op
      const after = await knex()('coupons')
        .where({ id: coupon.id })
        .first<{ redemption_count: number }>('redemption_count');
      expect(after.redemption_count).toBe(0);
      const released = await knex()('coupon_redemptions')
        .where({ order_id: chain.orderId })
        .first<{ status: string; released_at: Date | null }>('status', 'released_at');
      expect(released).toMatchObject({ status: 'released', released_at: expect.any(Date) as unknown });

      await redeem(coupon.id, chain.customerId, second);
      const detail = successBody<CouponBody>(
        await call(adminToken, 'get', `/admin/coupons/${coupon.id}`),
      ).data;
      expect(detail.redemptions?.map((r) => [r.orderId, r.status])).toEqual([
        [second, 'active'],
        [chain.orderId, 'released'],
      ]);
      // Released uses keep the coupon locked (PR-14).
      expect(
        (await call(adminToken, 'patch', `/admin/coupons/${coupon.id}`, { minItemsSubtotal: '5.00' })).status,
      ).toBe(409);
    });
  });
});
