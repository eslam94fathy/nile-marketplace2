import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type Money } from '../../../lib/money';
import { type ICatalogDirectory } from '../../catalog';
import { type ISellerDirectory, SellerStatus } from '../../sellers';
import { CouponFunding, CouponScope } from '../enums';
import {
  couponCodeUnknown,
  couponCustomerLimitReached,
  couponInactive,
  couponLimitReached,
  couponMinSubtotalNotMet,
  couponNotApplicable,
} from '../errors';
import { assertRedeemableAt, computeDiscount, type QuoteLine } from '../model/coupon.model';
import { type CouponRedemptionRepository } from '../repository/coupon-redemption.repository';
import { type CouponRepository } from '../repository/coupon.repository';
import { type ICouponRedemptions } from './coupon-redemption.service';

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
export interface IPromotions extends ICouponRedemptions {
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
}

@injectable()
export class PromotionsService implements IPromotions {
  constructor(
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.CouponRepository) private readonly coupons: CouponRepository,
    @inject(TOKENS.CouponRedemptionRepository) private readonly redemptions: CouponRedemptionRepository,
    @inject(TOKENS.CouponRedemptions) private readonly redemptionService: ICouponRedemptions,
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

  redeem(
    redemption: { couponId: string; customerId: string; orderId: string; discountTotal: Money },
    trx: DbTransaction,
  ): Promise<void> {
    return this.redemptionService.redeem(redemption, trx);
  }

  release(orderId: string, trx: DbTransaction): Promise<void> {
    return this.redemptionService.release(orderId, trx);
  }

  private async sellerApproved(sellerId: string | null): Promise<boolean> {
    if (sellerId === null) return false;
    const [seller] = await this.sellers.getStatuses([sellerId]);
    return seller?.status === SellerStatus.APPROVED;
  }
}
