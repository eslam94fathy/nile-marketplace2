/**
 * promotions module (docs/spec/19-promotions.md): coupon codes, their quote, redemption and release.
 * Owns tables: coupons, coupon_redemptions. No other module reads or writes them.
 * May call: sellers (seller guard), catalog (category subtree); audit rows go through lib/audit.
 * Called by cart (preview) and ordering (checkout, close step); calls neither back.
 */
export {
  CouponDisplayStatus,
  CouponFunding,
  CouponScope,
  CouponStatus,
  DiscountType,
  RedemptionStatus,
} from './enums';
