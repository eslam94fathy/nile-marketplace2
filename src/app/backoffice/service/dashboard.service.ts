import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { type ICache } from '../../../pkg/cache';
import { type IShipmentDirectory } from '../../delivery';
import { type IFinanceDirectory } from '../../finance';
import { type IOrderingDirectory } from '../../ordering';
import { type ISellerDirectory } from '../../sellers';
import { type ISupportDirectory } from '../../support';
import {
  DASHBOARD_CACHE_KEY,
  DASHBOARD_GMV_DAYS,
  DASHBOARD_RECENT_DAYS,
  DASHBOARD_TOP_SELLERS,
} from '../constants';
import { type DashboardDto } from '../dto/dashboard.dto';

type CacheEnv = Pick<Env, 'DASHBOARD_CACHE_TTL_SECONDS'>;

/**
 * `GET /admin/dashboard` (spec 20 §3.2): one stats call per owning module, composed here and cached as
 * one value for every admin. No invalidation: `generatedAt` shows the age (at most the TTL). Redis
 * failures degrade to a fresh computation with a `warn` (cache-aside, architecture §8).
 */
@injectable()
export class DashboardService {
  constructor(
    @inject(TOKENS.OrderingDirectory) private readonly ordering: IOrderingDirectory,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.SupportDirectory) private readonly support: ISupportDirectory,
    @inject(TOKENS.FinanceDirectory) private readonly finance: IFinanceDirectory,
    @inject(TOKENS.ShipmentDirectory) private readonly shipments: IShipmentDirectory,
    @inject(TOKENS.Cache) private readonly cache: ICache,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Env) private readonly env: CacheEnv,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async get(): Promise<DashboardDto> {
    const cached = await this.read();
    if (cached) return cached;
    const fresh = await this.compute();
    await this.write(fresh);
    return fresh;
  }

  private async compute(): Promise<DashboardDto> {
    const now = this.clock.now();
    const [orders, pendingApproval, support, finance, delivery] = await Promise.all([
      this.ordering.getDashboardStats({
        now,
        gmvDays: DASHBOARD_GMV_DAYS,
        recentDays: DASHBOARD_RECENT_DAYS,
        topSellers: DASHBOARD_TOP_SELLERS,
      }),
      this.sellers.countPendingApproval(),
      this.support.getStats(),
      this.finance.getDashboardStats(),
      this.shipments.getDashboardStats(),
    ]);
    const names = new Map(
      (await this.sellers.getSummaries(orders.topSellers.map((s) => s.sellerId))).map((s) => [
        s.sellerId,
        s.businessName,
      ]),
    );
    return {
      generatedAt: now.toISOString(),
      orders: {
        byStatus: orders.byStatus,
        placedToday: orders.placedToday,
        placedLast7Days: orders.placedRecent,
      },
      gmv: orders.gmv,
      topSellers: orders.topSellers.map((seller) => {
        const businessName = names.get(seller.sellerId);
        // seller_orders.seller_id is a FK to sellers: a miss is a broken invariant.
        if (businessName === undefined) throw new Error(`top seller ${seller.sellerId} has no profile`);
        return { ...seller, businessName };
      }),
      sellers: { pendingApproval },
      support,
      finance,
      delivery,
    };
  }

  private async read(): Promise<DashboardDto | undefined> {
    try {
      const raw = await this.cache.get(DASHBOARD_CACHE_KEY);
      if (raw === null) return undefined;
      const parsed = JSON.parse(raw) as Partial<DashboardDto> | null;
      if (typeof parsed?.generatedAt !== 'string' || !Array.isArray(parsed.gmv) || !parsed.orders) {
        throw new TypeError('cached dashboard has an unexpected shape');
      }
      return parsed as DashboardDto;
    } catch (error) {
      this.logger.warn('dashboard cache read failed, computing it', { key: DASHBOARD_CACHE_KEY, error });
      return undefined;
    }
  }

  private async write(dashboard: DashboardDto): Promise<void> {
    try {
      await this.cache.set(
        DASHBOARD_CACHE_KEY,
        JSON.stringify(dashboard),
        this.env.DASHBOARD_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn('dashboard cache write failed', { key: DASHBOARD_CACHE_KEY, error });
    }
  }
}
