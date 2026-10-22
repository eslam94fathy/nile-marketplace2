import { Money, type Rate } from '../../../lib/money';
import { couponExpired, couponInactive, couponNotActiveYet } from '../errors';
import {
  CouponDisplayStatus,
  CouponScope,
  CouponStatus,
  type CouponFunding,
  type DiscountType,
  type RedemptionStatus,
} from '../enums';

export type CouponDiscount =
  { type: typeof DiscountType.PERCENT; rate: Rate } | { type: typeof DiscountType.FIXED; amount: Money };

/** A coupon (spec 19 §1.1). */
export interface Coupon {
  id: string;
  code: string;
  funding: CouponFunding;
  sellerId: string | null;
  discount: CouponDiscount;
  maxDiscount: Money | null;
  minItemsSubtotal: Money;
  scope: CouponScope;
  scopeSellerId: string | null;
  scopeCategoryId: string | null;
  startsAt: Date;
  endsAt: Date;
  /** `null` = unlimited. */
  globalLimit: number | null;
  perCustomerLimit: number;
  /** Active redemptions. */
  redemptionCount: number;
  status: CouponStatus;
  /** Set once redeemed, never cleared: the fields are locked (PR-8, PR-14). */
  firstRedeemedAt: Date | null;
  adminBlockedAt: Date | null;
  adminBlockReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Every field a create sets; an update sets any of them (code and funding never change). */
export interface CouponFields {
  discount: CouponDiscount;
  maxDiscount: Money | null;
  minItemsSubtotal: Money;
  scope: CouponScope;
  scopeSellerId: string | null;
  scopeCategoryId: string | null;
  startsAt: Date;
  endsAt: Date;
  globalLimit: number | null;
  perCustomerLimit: number;
  status: CouponStatus;
}

export interface NewCoupon extends CouponFields {
  code: string;
  funding: CouponFunding;
  sellerId: string | null;
}

export interface Redemption {
  id: string;
  couponId: string;
  customerId: string;
  orderId: string;
  discountTotal: Money;
  status: RedemptionStatus;
  createdAt: Date;
}

/** `scheduled` / `expired` are derived from the dates (spec 19 §1). */
export function displayStatusOf(coupon: Coupon, now: Date): CouponDisplayStatus {
  if (coupon.status === CouponStatus.INACTIVE) return CouponDisplayStatus.INACTIVE;
  if (now < coupon.startsAt) return CouponDisplayStatus.SCHEDULED;
  if (now >= coupon.endsAt) return CouponDisplayStatus.EXPIRED;
  return CouponDisplayStatus.ACTIVE;
}

/** One cart line as the quote sees it (spec 19 §2). */
export interface QuoteLine {
  variantId: string;
  productId: string;
  sellerId: string;
  categoryId: string;
  lineTotal: Money;
}

export type DiscountOutcome =
  | { kind: 'not_applicable' }
  | { kind: 'min_not_met'; missing: Money }
  | {
      kind: 'ok';
      eligibleSubtotal: Money;
      discountTotal: Money;
      /** Every input line in input order; 0 for lines out of scope. */
      lines: { variantId: string; discount: Money }[];
    };

/**
 * Whether a line is in the coupon's scope (spec 19 §1.2 step 1): the seller, or the category subtree
 * (`scopeCategoryIds`), narrowed to the coupon's seller when it has one.
 */
function inScope(coupon: Coupon, line: QuoteLine, scopeCategoryIds: ReadonlySet<string>): boolean {
  if (coupon.scopeSellerId !== null && line.sellerId !== coupon.scopeSellerId) return false;
  if (coupon.scope === CouponScope.CATEGORY) return scopeCategoryIds.has(line.categoryId);
  return true;
}

/**
 * Spec 19 §1.2 steps 1–4: the eligible lines, the minimum, the discount (percent: round half-up and
 * capped at `maxDiscount`; fixed: at most the eligible subtotal), and its allocation to the eligible
 * lines in proportion to their totals with largest-remainder rounding (ties: the earlier line in cart
 * order), so the shares add up exactly and no line's share exceeds its total.
 * `scopeCategoryIds`: the scope category's subtree, empty unless the scope is `category`.
 */
export function computeDiscount(
  coupon: Coupon,
  lines: readonly QuoteLine[],
  scopeCategoryIds: ReadonlySet<string>,
): DiscountOutcome {
  const eligible = lines.map((line) => inScope(coupon, line, scopeCategoryIds));
  if (!eligible.some(Boolean)) return { kind: 'not_applicable' };
  const eligibleSubtotal = Money.sum(lines.filter((_, i) => eligible[i]).map((line) => line.lineTotal));
  if (eligibleSubtotal.lessThan(coupon.minItemsSubtotal)) {
    return { kind: 'min_not_met', missing: coupon.minItemsSubtotal.minus(eligibleSubtotal) };
  }

  let discountTotal: Money;
  if (coupon.discount.type === 'percent') {
    discountTotal = eligibleSubtotal.timesRate(coupon.discount.rate);
    if (coupon.maxDiscount && discountTotal.greaterThan(coupon.maxDiscount))
      discountTotal = coupon.maxDiscount;
  } else {
    discountTotal = coupon.discount.amount.greaterThan(eligibleSubtotal)
      ? eligibleSubtotal
      : coupon.discount.amount;
  }

  const shares = discountTotal.allocate(
    lines.map((line, i) => (eligible[i] ? line.lineTotal : Money.zero())),
  );
  return {
    kind: 'ok',
    eligibleSubtotal,
    discountTotal,
    lines: lines.map((line, i) => ({ variantId: line.variantId, discount: shares[i] ?? Money.zero() })),
  };
}

/** Spec 19 §3.1 step 1 after the lookup: the stored status, then the window `[startsAt, endsAt)`. */
export function assertRedeemableAt(coupon: Coupon, now: Date): void {
  if (coupon.status !== CouponStatus.ACTIVE) throw couponInactive();
  if (now < coupon.startsAt) throw couponNotActiveYet();
  if (now >= coupon.endsAt) throw couponExpired();
}
