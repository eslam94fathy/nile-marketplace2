import { type OpenSellerOrderStatus } from '../enums';

/** What the back-office asks for (spec 20 §3.2, BO-20): windows of business days ending today. */
export interface DashboardStatsQuery {
  now: Date;
  /** The GMV series and the top sellers, today included. */
  gmvDays: number;
  /** `placedRecent`, today included. */
  recentDays: number;
  topSellers: number;
}

/** Ordering's part of the dashboard (spec 20 §3.2). Amounts are money strings ("150.00"). */
export interface OrderingDashboardStats {
  /** Every open status (BO-13), zero when none. */
  byStatus: Record<OpenSellerOrderStatus, number>;
  placedToday: number;
  placedRecent: number;
  /** One entry per business day, oldest first, zero-filled. */
  gmv: { day: string; placed: string; delivered: string }[];
  /** By delivered GMV over the GMV window, highest first, ties by seller id. */
  topSellers: { sellerId: string; deliveredGmv: string }[];
}
