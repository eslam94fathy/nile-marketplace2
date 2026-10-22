import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type Money } from '../../../lib/money';
import { type ICatalogDirectory } from '../../catalog';
import { type ISellerDirectory, SellerStatus } from '../../sellers';
import { CouponFunding, CouponScope, CouponStatus } from '../enums';
import {
  couponCodeUnknown,
  couponCustomerLimitReached,
  couponExpired,
  couponInactive,
  couponLimitReached,
  couponMinSubtotalNotMet,
  couponNotActiveYet,
  couponNotApplicable,
} from '../errors';
import { computeDiscount, type Coupon, type QuoteLine } from '../model/coupon.model';
import { type CouponRedemptionRepository } from '../repository/coupon-redemption.repository';
import { type CouponRepository } from '../repository/coupon.repository';

/** What a valid code gives a set of cart lines (spec 19 §2). */
export interface CouponQuote {
  couponId: string;
  code: string;
  funding: CouponFunding;
  /** The funding seller; `null` for a platform coupon. */
  sellerId: string | null;
  discountTotal: Money;
  /** Every quoted line in input order, with its share (0 out of scope). */
  lines: { variantId: string; discount: Money }[];
}

/** Public API of promotions (spec 19 §2): cart's preview, ordering's checkout and close step. */
export interface IPromotions {
  /**
   * Reads only, no locks: §3.1 in order, then §1.2. With `trx` (checkout, PR-10) its own rows are read
   * in the caller's transaction. The code is upper-cased here (PR-12).
   */
  quote(
    code: string,
    customerId: string,
    lines: readonly QuoteLine[],
    trx?: DbTransaction,
  ): Promise<CouponQuote>;
  /** UC-PR-2: the last lock of the checkout. Throws the §3.1 code that now applies; the caller rolls back. */
  redeem(
    redemption: { couponId: string; customerId: string; orderId: string; discountTotal: Money },
    trx: DbTransaction,
  ): Promise<void>;
  /** UC-PR-3: only for an order that closes `cancelled` (R-18). No active redemption → no-op. */
  release(orderId: string, trx: DbTransaction): Promise<void>;
}

@injectable()
export class PromotionsService implements IPromotions {
  constructor(
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.CouponRepository) private readonly coupons: CouponRepository,
    @inject(TOKENS.CouponRedemptionRepository) private readonly redemptions: CouponRedemptionRepository,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.CatalogDirectory) private readonly catalog: ICatalogDirectory,
  ) {}

  async quote(
    code: string,
    customerId: string,
    lines: readonly QuoteLine[],
    trx?: DbTransaction,
  ): Promise<CouponQuote> {
    const coupon = await this.coupons.findByCode(code.toUpperCase(), trx);
    if (!coupon) throw couponCodeUnknown();
    assertRedeemableAt(coupon, this.clock.now());
    if (coupon.funding === CouponFunding.SELLER && !(await this.sellerApproved(coupon.sellerId))) {
      throw couponInactive();
    }
    // A soft read: redeem decides under the coupon's row lock (UC-PR-2).
    if (coupon.globalLimit !== null && coupon.redemptionCount >= coupon.globalLimit)
      throw couponLimitReached();
    if ((await this.redemptions.countActive(coupon.id, customerId, trx)) >= coupon.perCustomerLimit) {
      throw couponCustomerLimitReached();
    }

    const scopeCategoryIds = new Set(
      coupon.scope === CouponScope.CATEGORY && coupon.scopeCategoryId !== null
        ? await this.catalog.getCategorySubtreeIds(coupon.scopeCategoryId)
        : [],
    );
    const outcome = computeDiscount(coupon, lines, scopeCategoryIds);
    if (outcome.kind === 'not_applicable') throw couponNotApplicable();
    if (outcome.kind === 'min_not_met') throw couponMinSubtotalNotMet(outcome.missing);
    return {
      couponId: coupon.id,
      code: coupon.code,
      funding: coupon.funding,
      sellerId: coupon.sellerId,
      discountTotal: outcome.discountTotal,
      lines: outcome.lines,
    };
  }

  async redeem(
    redemption: { couponId: string; customerId: string; orderId: string; discountTotal: Money },
    trx: DbTransaction,
  ): Promise<void> {
    const perCustomerLimit = await this.coupons.takeUse(redemption.couponId, trx);
    if (perCustomerLimit === null) {
      const coupon = await this.coupons.findById(redemption.couponId, trx);
      if (!coupon) throw couponInactive();
      assertRedeemableAt(coupon, this.clock.now());
      throw couponLimitReached();
    }
    // The customer's checkouts are serialised by the cart lock (spec 09 §3.1 step 3): no race here.
    const used = await this.redemptions.countActive(redemption.couponId, redemption.customerId, trx);
    if (used >= perCustomerLimit) {
      throw couponCustomerLimitReached();
    }
    await this.redemptions.insert(redemption, trx);
  }

  async release(orderId: string, trx: DbTransaction): Promise<void> {
    const redemption = await this.redemptions.findActiveByOrderId(orderId, trx);
    if (!redemption) return;
    await this.redemptions.markReleased(redemption.id, trx);
    await this.coupons.giveUseBack(redemption.couponId, trx);
  }

  private async sellerApproved(sellerId: string | null): Promise<boolean> {
    if (sellerId === null) return false;
    const [seller] = await this.sellers.getStatuses([sellerId]);
    return seller?.status === SellerStatus.APPROVED;
  }
}

/** §3.1 step 1 after the lookup: the stored status, then the window `[startsAt, endsAt)`. */
function assertRedeemableAt(coupon: Coupon, now: Date): void {
  if (coupon.status !== CouponStatus.ACTIVE) throw couponInactive();
  if (now < coupon.startsAt) throw couponNotActiveYet();
  if (now >= coupon.endsAt) throw couponExpired();
}
