/** Paths under /api/v1 (spec 20 §3.2). */
export const BACKOFFICE_PATHS = {
  DASHBOARD: '/admin/dashboard',
} as const;

/** One value for every admin (spec 20 §3.2, architecture §8). */
export const DASHBOARD_CACHE_KEY = 'v1:backoffice:dashboard';

/** The dashboard windows in Cairo business days, today included (spec 20 §3.2, BO-20). */
export const DASHBOARD_GMV_DAYS = 30;
export const DASHBOARD_RECENT_DAYS = 7;
export const DASHBOARD_TOP_SELLERS = 10;
