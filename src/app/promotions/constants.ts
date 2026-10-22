export const PROMOTIONS_TABLES = {
  COUPONS: 'coupons',
  REDEMPTIONS: 'coupon_redemptions',
} as const;

/** Spec 19 §1.1, §4 limits (constants; they match the CHECKs of database D-26). */
export const COUPON_LIMITS = {
  CODE_MIN: 4,
  CODE_MAX: 32,
  /** Applied after upper-casing (PR-12). */
  CODE_PATTERN: /^[A-Z0-9-]{4,32}$/,
  PERCENT_MIN: '0.01',
  PERCENT_MAX: '0.90',
  GLOBAL_LIMIT_MIN: 1,
  GLOBAL_LIMIT_MAX: 1_000_000,
  PER_CUSTOMER_LIMIT_MIN: 1,
  PER_CUSTOMER_LIMIT_MAX: 100,
  BLOCK_REASON_MIN: 3,
  BLOCK_REASON_MAX: 500,
  /** The admin coupon detail's redemptions (spec 19 §4.3). */
  RECENT_REDEMPTIONS: 50,
} as const;

/** Paths under /api/v1 (spec 19 §4.2, §4.3). */
export const COUPON_PATHS = {
  SELLER_COUPONS: '/seller/coupons',
  SELLER_COUPON: '/seller/coupons/:couponId',
  ADMIN_COUPONS: '/admin/coupons',
  ADMIN_COUPON: '/admin/coupons/:couponId',
  ADMIN_BLOCK: '/admin/coupons/:couponId/block',
  ADMIN_UNBLOCK: '/admin/coupons/:couponId/unblock',
} as const;
