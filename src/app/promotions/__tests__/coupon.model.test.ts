import { describe, expect, it } from 'vitest';
import { Money, Rate } from '../../../lib/money';
import { CouponDisplayStatus, CouponFunding, CouponScope, CouponStatus, DiscountType } from '../enums';
import { computeDiscount, type Coupon, displayStatusOf, type QuoteLine } from '../model/coupon.model';
import {
  changedFields,
  couponDraftProblems,
  type CouponDraft,
  draftOf,
  lockedChanges,
} from '../model/coupon-rules.model';

const m = (value: string) => Money.of(value);
const NOW = new Date('2026-10-22T12:00:00Z');
const DAY = 86_400_000;

const coupon = (overrides: Partial<Coupon> = {}): Coupon => ({
  id: 'coupon-1',
  code: 'SAVE-10',
  funding: CouponFunding.PLATFORM,
  sellerId: null,
  discount: { type: DiscountType.PERCENT, rate: Rate.of('0.1000') },
  maxDiscount: null,
  minItemsSubtotal: m('0.00'),
  scope: CouponScope.ALL,
  scopeSellerId: null,
  scopeCategoryId: null,
  startsAt: new Date(NOW.getTime() - DAY),
  endsAt: new Date(NOW.getTime() + DAY),
  globalLimit: null,
  perCustomerLimit: 1,
  redemptionCount: 0,
  status: CouponStatus.ACTIVE,
  firstRedeemedAt: null,
  adminBlockedAt: null,
  adminBlockReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const line = (variantId: string, total: string, sellerId = 's1', categoryId = 'c1'): QuoteLine => ({
  variantId,
  productId: `p-${variantId}`,
  sellerId,
  categoryId,
  lineTotal: m(total),
});

const shares = (outcome: ReturnType<typeof computeDiscount>) =>
  outcome.kind === 'ok' ? outcome.lines.map((l) => l.discount.toString()) : outcome.kind;

describe('promotions computeDiscount (spec 19 §1.2)', () => {
  it('percent: rounded half-up, allocated exactly with largest remainders', () => {
    const outcome = computeDiscount(
      coupon(),
      [line('a', '100.00'), line('b', '100.00'), line('c', '133.35')],
      new Set(),
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.discountTotal.toString()).toBe('33.34'); // 33.335 → 33.34
    expect(Money.sum(outcome.lines.map((l) => l.discount)).toString()).toBe('33.34');
    expect(shares(outcome)).toEqual(['10.00', '10.00', '13.34']);
  });

  it('percent is capped at maxDiscount; fixed never exceeds the eligible subtotal', () => {
    const capped = computeDiscount(coupon({ maxDiscount: m('5.00') }), [line('a', '100.00')], new Set());
    expect(capped.kind === 'ok' && capped.discountTotal.toString()).toBe('5.00');
    const fixed = coupon({ discount: { type: DiscountType.FIXED, amount: m('500.00') } });
    const outcome = computeDiscount(fixed, [line('a', '30.00'), line('b', '20.00')], new Set());
    expect(shares(outcome)).toEqual(['30.00', '20.00']);
  });

  it('only lines in scope share the discount; out-of-scope lines get 0', () => {
    const bySeller = coupon({ scope: CouponScope.SELLER, scopeSellerId: 's2' });
    expect(
      shares(computeDiscount(bySeller, [line('a', '100.00'), line('b', '50.00', 's2')], new Set())),
    ).toEqual(['0.00', '5.00']);
    const byCategory = coupon({ scope: CouponScope.CATEGORY, scopeCategoryId: 'c1' });
    const lines = [line('a', '100.00', 's1', 'c2'), line('b', '50.00', 's1', 'c9')];
    expect(shares(computeDiscount(byCategory, lines, new Set(['c1', 'c2'])))).toEqual(['10.00', '0.00']);
    // A seller's category coupon still covers only that seller's products.
    const sellerCategory = coupon({
      funding: CouponFunding.SELLER,
      sellerId: 's2',
      scope: CouponScope.CATEGORY,
      scopeSellerId: 's2',
      scopeCategoryId: 'c1',
    });
    expect(shares(computeDiscount(sellerCategory, [line('a', '100.00', 's1', 'c1')], new Set(['c1'])))).toBe(
      'not_applicable',
    );
  });

  it('the minimum is compared with the eligible subtotal and reports what is missing', () => {
    const outcome = computeDiscount(
      coupon({ scope: CouponScope.SELLER, scopeSellerId: 's1', minItemsSubtotal: m('200.00') }),
      [line('a', '150.00'), line('b', '500.00', 's2')],
      new Set(),
    );
    expect(outcome.kind === 'min_not_met' && outcome.missing.toString()).toBe('50.00');
  });

  it('shares add up and stay within each line over random carts', () => {
    let seed = 11;
    const random = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let run = 0; run < 300; run += 1) {
      const lines = Array.from({ length: 1 + random(6) }, (_, i) =>
        line(`v${i}`, `${1 + random(900)}.${String(random(100)).padStart(2, '0')}`, random(2) ? 's1' : 's2'),
      );
      const percent = Rate.of(`0.${String(1 + random(89)).padStart(2, '0')}`);
      const c = random(2)
        ? coupon({ discount: { type: DiscountType.PERCENT, rate: percent } })
        : coupon({ discount: { type: DiscountType.FIXED, amount: m(`${1 + random(2000)}.00`) } });
      const outcome = computeDiscount(c, lines, new Set());
      if (outcome.kind !== 'ok') throw new Error('every line is in scope');
      expect(Money.sum(outcome.lines.map((l) => l.discount)).equals(outcome.discountTotal)).toBe(true);
      outcome.lines.forEach((l, i) =>
        expect(l.discount.greaterThan(lines[i]?.lineTotal ?? m('0'))).toBe(false),
      );
    }
  });

  it('displayStatus is derived from the status and the window', () => {
    expect(displayStatusOf(coupon(), NOW)).toBe(CouponDisplayStatus.ACTIVE);
    expect(displayStatusOf(coupon({ startsAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(
      CouponDisplayStatus.SCHEDULED,
    );
    expect(displayStatusOf(coupon({ endsAt: NOW }), NOW)).toBe(CouponDisplayStatus.EXPIRED);
    expect(displayStatusOf(coupon({ status: CouponStatus.INACTIVE }), NOW)).toBe(
      CouponDisplayStatus.INACTIVE,
    );
  });
});

describe('promotions coupon rules (spec 19 §4, PR-8, PR-13)', () => {
  const draft = (overrides: Partial<CouponDraft> = {}): CouponDraft => ({
    ...draftOf(coupon()),
    ...overrides,
  });
  const context: Parameters<typeof couponDraftProblems>[1] = {
    funding: CouponFunding.PLATFORM,
    sellerId: null,
    now: NOW,
    endsAtChanged: true,
    redemptionCount: 0,
  };
  const fields = (d: CouponDraft, c: Partial<typeof context> = {}) =>
    couponDraftProblems(d, { ...context, ...c }).map((p) => `${p.field}:${p.constraint}`);

  it('accepts a consistent coupon', () => {
    expect(fields(draft())).toEqual([]);
    expect(fields(draft({ discountType: DiscountType.FIXED, discountValue: '25.50' }))).toEqual([]);
  });

  it('checks the discount value against its type and maxDiscount against percent', () => {
    expect(fields(draft({ discountValue: '0.95' }))).toEqual(['discountValue:rate']);
    expect(fields(draft({ discountValue: '0.005' }))).toEqual(['discountValue:rate']);
    expect(fields(draft({ discountValue: '10' }))).toEqual(['discountValue:rate']);
    expect(fields(draft({ discountType: DiscountType.FIXED, discountValue: '0' }))).toEqual([
      'discountValue:money',
    ]);
    expect(
      fields(draft({ discountType: DiscountType.FIXED, discountValue: '5.00', maxDiscount: '3.00' })),
    ).toEqual(['maxDiscount:percent_only']);
  });

  it('checks each scope with its ids, and a seller coupon covers only its seller', () => {
    expect(fields(draft({ scope: CouponScope.SELLER }))).toEqual(['scopeSellerId:scope']);
    expect(fields(draft({ scopeSellerId: 's1' }))).toEqual(['scopeSellerId:scope']);
    expect(fields(draft({ scope: CouponScope.CATEGORY }))).toEqual(['scopeCategoryId:scope']);
    const seller = { funding: CouponFunding.SELLER, sellerId: 's1' };
    expect(fields(draft({ scopeSellerId: 's1' }), seller)).toEqual(['scope:seller_scope']);
    expect(fields(draft({ scope: CouponScope.SELLER, scopeSellerId: 's2' }), seller)).toEqual([
      'scopeSellerId:own_seller',
    ]);
    expect(fields(draft({ scope: CouponScope.SELLER, scopeSellerId: 's1' }), seller)).toEqual([]);
  });

  it('checks the window and the global limit against the uses', () => {
    expect(fields(draft({ endsAt: new Date(NOW.getTime() - 2 * DAY) }))).toEqual([
      'endsAt:after_starts_at',
      'endsAt:future',
    ]);
    // An unchanged endsAt in the past is fine on a patch of another field.
    expect(fields(draft({ endsAt: new Date(NOW.getTime() - 1) }), { endsAtChanged: false })).toEqual([]);
    expect(fields(draft({ globalLimit: 2 }), { redemptionCount: 3 })).toEqual(['globalLimit:redemptions']);
  });

  it('reports changed fields by value and only the locked ones after a redemption', () => {
    const before = draft();
    expect(changedFields(before, { ...before, discountValue: '0.1' })).toEqual([]);
    const after = {
      ...before,
      minItemsSubtotal: '10',
      endsAt: new Date(NOW.getTime() + 2 * DAY),
      status: CouponStatus.INACTIVE,
    };
    const changed = changedFields(before, after);
    expect(changed).toEqual(['minItemsSubtotal', 'endsAt', 'status']);
    expect(lockedChanges(changed)).toEqual(['minItemsSubtotal']);
  });
});
