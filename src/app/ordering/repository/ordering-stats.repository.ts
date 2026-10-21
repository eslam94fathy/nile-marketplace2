import { inject, injectable } from 'tsyringe';
import { BUSINESS_TIME_ZONE } from '../../../lib/clock';
import { type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { ORDERING_TABLES } from '../constants';
import { OPEN_SELLER_ORDER_STATUSES, type OpenSellerOrderStatus, SellerOrderStatus } from '../enums';
import { type DashboardStatsQuery, type OrderingDashboardStats } from '../model/dashboard-stats.model';

const ORDERS = ORDERING_TABLES.ORDERS;
const SELLER_ORDERS = ORDERING_TABLES.SELLER_ORDERS;

interface BusinessDay {
  day: string;
  starts_at: Date;
  ends_at: Date;
}

/**
 * The back-office figures over orders and seller orders (spec 20 §3.2). Reads without locks or a
 * transaction: the dashboard may be a minute old anyway (its cache TTL). Day boundaries are Cairo
 * business days (BO-5), from the injected `now` so tests can stand on either side of midnight.
 */
@injectable()
export class OrderingStatsRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  async getDashboardStats(query: DashboardStatsQuery): Promise<OrderingDashboardStats> {
    const days = await this.businessDays(query.now, query.gmvDays);
    const first = days[0];
    const today = days.at(-1);
    const recent = days.at(-query.recentDays);
    if (!first || !today || !recent) throw new Error('dashboard windows need at least one day');
    const window = { from: first.starts_at, to: today.ends_at };

    const [byStatus, placed, placedGmv, deliveredGmv, topSellers] = await Promise.all([
      this.openStatusCounts(),
      this.placedCounts(today.starts_at, recent.starts_at, window.to),
      this.placedGmvByDay(window),
      this.deliveredGmvByDay(window),
      this.topSellers(window, query.topSellers),
    ]);
    const zero = Money.zero().toString();
    return {
      byStatus,
      ...placed,
      gmv: days.map(({ day }) => ({
        day,
        placed: placedGmv.get(day) ?? zero,
        delivered: deliveredGmv.get(day) ?? zero,
      })),
      topSellers,
    };
  }

  /** The last `count` Cairo days ending on `now`'s, oldest first, with their UTC bounds. */
  private async businessDays(now: Date, count: number): Promise<BusinessDay[]> {
    const result = await this.db.knex.raw<{ rows: BusinessDay[] }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
              d AT TIME ZONE :tz AS starts_at,
              (d + interval '1 day') AT TIME ZONE :tz AS ends_at
         -- timestamp (local) bounds: with dates Postgres picks the timestamptz overload, and
         -- AT TIME ZONE would then convert the wrong way.
         FROM generate_series(
                ((:now::timestamptz AT TIME ZONE :tz)::date - (:count::int - 1))::timestamp,
                (:now::timestamptz AT TIME ZONE :tz)::date::timestamp,
                interval '1 day'
              ) AS d
        ORDER BY d`,
      { tz: BUSINESS_TIME_ZONE, now, count },
    );
    return result.rows;
  }

  /** BO-13; served by `idx_seller_orders_open_status` (D-22). */
  private async openStatusCounts(): Promise<Record<OpenSellerOrderStatus, number>> {
    const rows = await this.db
      .knex(SELLER_ORDERS)
      .select('status')
      .count<{ status: OpenSellerOrderStatus; count: string }[]>('* as count')
      .whereIn('status', OPEN_SELLER_ORDER_STATUSES)
      .groupBy('status');
    const counts = Object.fromEntries(OPEN_SELLER_ORDER_STATUSES.map((status) => [status, 0])) as Record<
      OpenSellerOrderStatus,
      number
    >;
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  /** `idx_orders_placed_at`; an unpaid Kashier order has no `placed_at` yet. */
  private async placedCounts(
    todayStart: Date,
    recentStart: Date,
    end: Date,
  ): Promise<{ placedToday: number; placedRecent: number }> {
    const row = await this.db
      .knex(ORDERS)
      .where('placed_at', '>=', recentStart)
      .where('placed_at', '<', end)
      .first<{ today: string; recent: string }>(
        this.db.knex.raw('count(*) FILTER (WHERE placed_at >= ?) AS today', [todayStart]),
        this.db.knex.raw('count(*) AS recent'),
      );
    return { placedToday: Number(row.today), placedRecent: Number(row.recent) };
  }

  /** BO-12, BO-22: current subtotals of the seller orders placed that day, except cancelled ones. */
  private async placedGmvByDay(window: { from: Date; to: Date }): Promise<Map<string, string>> {
    const result = await this.db.knex.raw<{ rows: { day: string; amount: string }[] }>(
      `SELECT to_char(o.placed_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day, sum(so.subtotal) AS amount
         FROM ${ORDERS} o
         JOIN ${SELLER_ORDERS} so ON so.order_id = o.id
        WHERE o.placed_at >= :from AND o.placed_at < :to AND so.status <> :cancelled
        GROUP BY 1`,
      { tz: BUSINESS_TIME_ZONE, ...window, cancelled: SellerOrderStatus.CANCELLED },
    );
    return toAmounts(result.rows);
  }

  /** BO-7; index-only through `idx_seller_orders_delivered_at`. */
  private async deliveredGmvByDay(window: { from: Date; to: Date }): Promise<Map<string, string>> {
    const result = await this.db.knex.raw<{ rows: { day: string; amount: string }[] }>(
      `SELECT to_char(delivered_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day, sum(subtotal) AS amount
         FROM ${SELLER_ORDERS}
        WHERE delivered_at >= :from AND delivered_at < :to
        GROUP BY 1`,
      { tz: BUSINESS_TIME_ZONE, ...window },
    );
    return toAmounts(result.rows);
  }

  private async topSellers(
    window: { from: Date; to: Date },
    limit: number,
  ): Promise<{ sellerId: string; deliveredGmv: string }[]> {
    const rows = await this.db
      .knex(SELLER_ORDERS)
      .select('seller_id')
      .sum<{ seller_id: string; amount: string }[]>('subtotal as amount')
      .where('delivered_at', '>=', window.from)
      .where('delivered_at', '<', window.to)
      .groupBy('seller_id')
      .orderBy([
        { column: 'amount', order: 'desc' },
        { column: 'seller_id', order: 'asc' },
      ])
      .limit(limit);
    return rows.map((row) => ({ sellerId: row.seller_id, deliveredGmv: Money.of(row.amount).toString() }));
  }
}

function toAmounts(rows: readonly { day: string; amount: string }[]): Map<string, string> {
  return new Map(rows.map((row) => [row.day, Money.of(row.amount).toString()]));
}
