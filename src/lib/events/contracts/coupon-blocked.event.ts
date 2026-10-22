import { defineEvent } from './define-event';

/** Publisher: promotions (spec 19 PR-20). `coupon.blocked` → notifications (the seller, NO-35). */
export interface CouponBlockedPayload {
  couponId: string;
  sellerId: string;
  /** ISO-8601. */
  at: string;
}

export const CouponBlocked = defineEvent<CouponBlockedPayload>('coupon.blocked', 1, 'coupon');
