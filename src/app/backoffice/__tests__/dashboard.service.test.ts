import { describe, expect, it, vi } from 'vitest';
import { type ILogger } from '../../../lib/logger';
import { type ICache } from '../../../pkg/cache';
import { type IOrderingDirectory, type OrderingDashboardStats } from '../../ordering';
import { type ISellerDirectory } from '../../sellers';
import { type ISupportDirectory } from '../../support';
import { DASHBOARD_CACHE_KEY } from '../constants';
import { type DashboardDto } from '../dto/dashboard.dto';
import { DashboardService } from '../service/dashboard.service';

const NOW = new Date('2026-07-15T21:30:00Z');
const SELLER_ID = '0192f5e0-0000-7000-8000-0000000000a1';

const ORDERING_STATS: OrderingDashboardStats = {
  byStatus: {
    pending_payment: 0,
    placed: 2,
    accepted: 1,
    ready_for_pickup: 0,
    picked_up: 0,
    out_for_delivery: 0,
    delivery_failed: 0,
    returning_to_seller: 0,
  },
  placedToday: 1,
  placedRecent: 3,
  gmv: [{ day: '2026-07-16', placed: '100.00', delivered: '70.00' }],
  topSellers: [{ sellerId: SELLER_ID, deliveredGmv: '70.00' }],
};

function setup(cache: Partial<ICache> = {}) {
  const ordering = { getDashboardStats: vi.fn(() => Promise.resolve(ORDERING_STATS)) };
  const sellers = {
    countPendingApproval: vi.fn(() => Promise.resolve(4)),
    getSummaries: vi.fn(() =>
      Promise.resolve([{ sellerId: SELLER_ID, businessName: 'Nile Shop', ratingAvg: null, ratingCount: 0 }]),
    ),
  };
  const support = { getStats: vi.fn(() => Promise.resolve({ open: 1, awaitingAdmin: 2, slaBreached: 0 })) };
  const finance = {
    getDashboardStats: vi.fn(() =>
      Promise.resolve({ codOutstanding: '10.00', sellerPayable: '20.00', agentFeePayable: '0.00' }),
    ),
  };
  const shipments = {
    getDashboardStats: vi.fn(() => Promise.resolve({ awaitingAssignment: 3, outForDelivery: 1 })),
  };
  const set = vi.fn((_key: string, _value: string, _ttl: number) => Promise.resolve());
  const store = { get: vi.fn(() => Promise.resolve(null)), set, ...cache };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() };
  const service = new DashboardService(
    ordering as unknown as IOrderingDirectory,
    sellers as unknown as ISellerDirectory,
    support as unknown as ISupportDirectory,
    finance,
    shipments,
    store as unknown as ICache,
    { now: () => NOW },
    { DASHBOARD_CACHE_TTL_SECONDS: 60 },
    logger as unknown as ILogger,
  );
  return { service, ordering, set, logger };
}

const EXPECTED: DashboardDto = {
  generatedAt: NOW.toISOString(),
  orders: { byStatus: ORDERING_STATS.byStatus, placedToday: 1, placedLast7Days: 3 },
  gmv: ORDERING_STATS.gmv,
  topSellers: [{ sellerId: SELLER_ID, businessName: 'Nile Shop', deliveredGmv: '70.00' }],
  sellers: { pendingApproval: 4 },
  support: { open: 1, awaitingAdmin: 2, slaBreached: 0 },
  finance: { codOutstanding: '10.00', sellerPayable: '20.00', agentFeePayable: '0.00' },
  delivery: { awaitingAssignment: 3, outForDelivery: 1 },
};

/* Spec 20 §3.2: composed from the owning modules, cached as one value, Redis failures degrade. */
describe('DashboardService', () => {
  it('composes the modules on a miss and caches the result for the TTL', async () => {
    const { service, ordering, set } = setup();
    expect(await service.get()).toEqual(EXPECTED);
    expect(ordering.getDashboardStats).toHaveBeenCalledWith({
      now: NOW,
      gmvDays: 30,
      recentDays: 7,
      topSellers: 10,
    });
    const [key, value, ttl] = set.mock.calls[0] ?? [];
    expect([key, ttl]).toEqual([DASHBOARD_CACHE_KEY, 60]);
    expect(JSON.parse(String(value))).toEqual(EXPECTED);
  });

  it('serves a cached value without asking the modules', async () => {
    const { service, ordering } = setup({ get: () => Promise.resolve(JSON.stringify(EXPECTED)) });
    expect(await service.get()).toEqual(EXPECTED);
    expect(ordering.getDashboardStats).not.toHaveBeenCalled();
  });

  it('computes fresh, with a warn, when Redis fails or holds an unexpected shape', async () => {
    for (const get of [() => Promise.reject(new Error('redis down')), () => Promise.resolve('{"x":1}')]) {
      const { service, logger } = setup({ get, set: () => Promise.reject(new Error('redis down')) });
      expect(await service.get()).toEqual(EXPECTED);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    }
  });
});
