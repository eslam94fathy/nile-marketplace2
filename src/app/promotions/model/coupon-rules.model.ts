import { type ErrorDetail } from '../../../lib/error';
import { MONEY_PATTERN } from '../../../lib/http';
import { Money, Rate } from '../../../lib/money';
import { CouponFunding, CouponScope, DiscountType, type CouponStatus } from '../enums';
import { type Coupon, type CouponDiscount, type CouponFields } from './coupon.model';

/** A rate with up to 4 decimals, as `discountValue` of a percent coupon (spec 19 §1.1). */
const RATE_VALUE = /^0(\.\d{1,4})?$/;
/** 0.01..0.90 in ten-thousandths: the bounds are exact at this scale. */
const PERCENT_RANGE = { min: 100, max: 9000 } as const;

/** What a create or a patch asks for, as plain values (the DTOs check types and lengths). */
export interface CouponDraft {
  discountType: DiscountType;
  discountValue: string;
  maxDiscount: string | null;
  minItemsSubtotal: string;
  scope: CouponScope;
  scopeSellerId: string | null;
  scopeCategoryId: string | null;
  startsAt: Date;
  endsAt: Date;
  globalLimit: number | null;
  perCustomerLimit: number;
  status: CouponStatus;
}

const problem = (field: string, constraint: string, message: string): ErrorDetail => ({
  field,
  constraint,
  message,
});

function discountProblems(draft: CouponDraft): ErrorDetail[] {
  const problems: ErrorDetail[] = [];
  if (draft.discountType === DiscountType.PERCENT) {
    const tenThousandths = RATE_VALUE.test(draft.discountValue)
      ? Math.round(Number(draft.discountValue) * 10_000)
      : -1;
    if (tenThousandths < PERCENT_RANGE.min || tenThousandths > PERCENT_RANGE.max) {
      problems.push(problem('discountValue', 'rate', 'a percent coupon takes a rate from 0.01 to 0.90'));
    }
  } else {
    if (!MONEY_PATTERN.test(draft.discountValue) || Money.of(draft.discountValue).isZero()) {
      problems.push(problem('discountValue', 'money', 'a fixed coupon takes an amount above 0'));
    }
    if (draft.maxDiscount !== null) {
      problems.push(problem('maxDiscount', 'percent_only', 'only a percent coupon has a maximum discount'));
    }
  }
  if (draft.maxDiscount !== null && Money.of(draft.maxDiscount).isZero()) {
    problems.push(problem('maxDiscount', 'positive', 'the maximum discount must be above 0'));
  }
  return problems;
}

/** Spec 19 §1.1: each scope's ids; a seller-funded coupon is `seller` or `category` of its own seller. */
function scopeProblems(draft: CouponDraft, funding: CouponFunding, sellerId: string | null): ErrorDetail[] {
  const problems: ErrorDetail[] = [];
  if (funding === CouponFunding.SELLER) {
    if (draft.scope === CouponScope.ALL) {
      problems.push(
        problem('scope', 'seller_scope', 'a seller coupon covers your products: seller or category'),
      );
    }
    if (draft.scopeSellerId !== sellerId) {
      problems.push(problem('scopeSellerId', 'own_seller', 'a seller coupon covers only your own products'));
    }
  } else {
    const wantsSeller = draft.scope === CouponScope.SELLER;
    if (wantsSeller !== (draft.scopeSellerId !== null)) {
      problems.push(
        problem('scopeSellerId', 'scope', 'scopeSellerId goes with scope seller, and only with it'),
      );
    }
  }
  if ((draft.scope === CouponScope.CATEGORY) !== (draft.scopeCategoryId !== null)) {
    problems.push(
      problem('scopeCategoryId', 'scope', 'scopeCategoryId goes with scope category, and only with it'),
    );
  }
  return problems;
}

/**
 * The cross-field rules of a create or of a coupon after a patch (spec 19 §4 `COUPON_INVALID`, PR-13).
 * `endsAtChanged`: a create, or a patch that moves `endsAt`, which must then lie in the future.
 */
export function couponDraftProblems(
  draft: CouponDraft,
  context: {
    funding: CouponFunding;
    sellerId: string | null;
    now: Date;
    endsAtChanged: boolean;
    redemptionCount: number;
  },
): ErrorDetail[] {
  const problems = [...discountProblems(draft), ...scopeProblems(draft, context.funding, context.sellerId)];
  if (draft.startsAt >= draft.endsAt) {
    problems.push(problem('endsAt', 'after_starts_at', 'endsAt must be after startsAt'));
  }
  if (context.endsAtChanged && draft.endsAt <= context.now) {
    problems.push(problem('endsAt', 'future', 'endsAt must be in the future'));
  }
  if (draft.globalLimit !== null && draft.globalLimit < context.redemptionCount) {
    problems.push(
      problem('globalLimit', 'redemptions', `the coupon is already used ${context.redemptionCount} times`),
    );
  }
  return problems;
}

/** The draft as stored values. Call only on a draft without problems. */
export function fieldsOf(draft: CouponDraft): CouponFields {
  const discount: CouponDiscount =
    draft.discountType === DiscountType.PERCENT
      ? { type: DiscountType.PERCENT, rate: Rate.of(draft.discountValue) }
      : { type: DiscountType.FIXED, amount: Money.of(draft.discountValue) };
  return {
    discount,
    maxDiscount: draft.maxDiscount === null ? null : Money.of(draft.maxDiscount),
    minItemsSubtotal: Money.of(draft.minItemsSubtotal),
    scope: draft.scope,
    scopeSellerId: draft.scopeSellerId,
    scopeCategoryId: draft.scopeCategoryId,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
    globalLimit: draft.globalLimit,
    perCustomerLimit: draft.perCustomerLimit,
    status: draft.status,
  };
}

/** A stored coupon as a draft, the base a patch is merged onto. */
export function draftOf(coupon: Coupon): CouponDraft {
  return {
    discountType: coupon.discount.type,
    discountValue: discountValueOf(coupon.discount),
    maxDiscount: coupon.maxDiscount?.toString() ?? null,
    minItemsSubtotal: coupon.minItemsSubtotal.toString(),
    scope: coupon.scope,
    scopeSellerId: coupon.scopeSellerId,
    scopeCategoryId: coupon.scopeCategoryId,
    startsAt: coupon.startsAt,
    endsAt: coupon.endsAt,
    globalLimit: coupon.globalLimit,
    perCustomerLimit: coupon.perCustomerLimit,
    status: coupon.status,
  };
}

/** "0.1000" for a rate, "25.50" for an amount (spec 19 §4 `discountValue`). */
export function discountValueOf(discount: CouponDiscount): string {
  return discount.type === DiscountType.PERCENT ? discount.rate.toString() : discount.amount.toString();
}

/** Fields compared as their API strings; numbers by value (`"0.1"` and `"0.1000"` are one rate). */
function comparable(draft: CouponDraft): Record<keyof CouponDraft, string> {
  const discountValue =
    draft.discountType === DiscountType.PERCENT && RATE_VALUE.test(draft.discountValue)
      ? Rate.of(draft.discountValue).toString()
      : MONEY_PATTERN.test(draft.discountValue)
        ? Money.of(draft.discountValue).toString()
        : draft.discountValue;
  const money = (value: string | null) =>
    value !== null && MONEY_PATTERN.test(value) ? Money.of(value).toString() : String(value);
  return {
    discountType: draft.discountType,
    discountValue,
    maxDiscount: money(draft.maxDiscount),
    minItemsSubtotal: money(draft.minItemsSubtotal),
    scope: draft.scope,
    scopeSellerId: String(draft.scopeSellerId),
    scopeCategoryId: String(draft.scopeCategoryId),
    startsAt: draft.startsAt.toISOString(),
    endsAt: draft.endsAt.toISOString(),
    globalLimit: String(draft.globalLimit),
    perCustomerLimit: String(draft.perCustomerLimit),
    status: draft.status,
  };
}

export function changedFields(before: CouponDraft, after: CouponDraft): (keyof CouponDraft)[] {
  const a = comparable(before);
  const b = comparable(after);
  return (Object.keys(a) as (keyof CouponDraft)[]).filter((field) => a[field] !== b[field]);
}

/** PR-8: what may still change after the first redemption. */
const UNLOCKED_FIELDS: ReadonlySet<keyof CouponDraft> = new Set(['endsAt', 'globalLimit', 'status']);

export function lockedChanges(changed: readonly (keyof CouponDraft)[]): (keyof CouponDraft)[] {
  return changed.filter((field) => !UNLOCKED_FIELDS.has(field));
}

/** The audit values of a coupon (spec 20 §2.3: every field except the counters). */
export function auditValuesOf(coupon: Coupon): Record<string, string | number | null> {
  return {
    code: coupon.code,
    funding: coupon.funding,
    sellerId: coupon.sellerId,
    discountType: coupon.discount.type,
    discountValue: discountValueOf(coupon.discount),
    maxDiscount: coupon.maxDiscount?.toString() ?? null,
    minItemsSubtotal: coupon.minItemsSubtotal.toString(),
    scope: coupon.scope,
    scopeSellerId: coupon.scopeSellerId,
    scopeCategoryId: coupon.scopeCategoryId,
    startsAt: coupon.startsAt.toISOString(),
    endsAt: coupon.endsAt.toISOString(),
    globalLimit: coupon.globalLimit,
    perCustomerLimit: coupon.perCustomerLimit,
    status: coupon.status,
  };
}
