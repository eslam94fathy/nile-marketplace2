/** Values match `chk_coupons_funding` and `chk_seller_orders_discount_funding` (spec 19 §1, R-17). */
export const CouponFunding = {
  PLATFORM: 'platform',
  SELLER: 'seller',
} as const;
export type CouponFunding = (typeof CouponFunding)[keyof typeof CouponFunding];

/** Values match `chk_coupons_discount_type`. */
export const DiscountType = {
  PERCENT: 'percent',
  FIXED: 'fixed',
} as const;
export type DiscountType = (typeof DiscountType)[keyof typeof DiscountType];

/** Values match `chk_coupons_scope_values`. A seller-funded coupon is `seller` or `category`. */
export const CouponScope = {
  ALL: 'all',
  SELLER: 'seller',
  CATEGORY: 'category',
} as const;
export type CouponScope = (typeof CouponScope)[keyof typeof CouponScope];

/** Values match `chk_coupons_status`: the stored status. */
export const CouponStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;
export type CouponStatus = (typeof CouponStatus)[keyof typeof CouponStatus];

/** Derived from the stored status and the dates, for display only (spec 19 §1, `displayStatus`). */
export const CouponDisplayStatus = {
  SCHEDULED: 'scheduled',
  ACTIVE: 'active',
  EXPIRED: 'expired',
  INACTIVE: 'inactive',
} as const;
export type CouponDisplayStatus = (typeof CouponDisplayStatus)[keyof typeof CouponDisplayStatus];

/** Values match `chk_coupon_redemptions_status`. */
export const RedemptionStatus = {
  ACTIVE: 'active',
  RELEASED: 'released',
} as const;
export type RedemptionStatus = (typeof RedemptionStatus)[keyof typeof RedemptionStatus];
