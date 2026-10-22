import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type Money } from '../../../lib/money';
import { couponCustomerLimitReached, couponInactive, couponLimitReached } from '../errors';
import { assertRedeemableAt } from '../model/coupon.model';
import { type CouponRedemptionRepository } from '../repository/coupon-redemption.repository';
import { type CouponRepository } from '../repository/coupon.repository';

/**
 * The write half of promotions' public API (spec 19 UC-PR-2, UC-PR-3), with no lookups into other
 * modules: the worker's close step (order jobs, shipment updates) releases redemptions too.
 */
export interface ICouponRedemptions {
  /** UC-PR-2: the last lock of the checkout. Throws the §3.1 code that now applies; the caller rolls back. */
  redeem(
    redemption: { couponId: string; customerId: string; orderId: string; discountTotal: Money },
    trx: DbTransaction,
  ): Promise<void>;
  /** UC-PR-3: only for an order that closes `cancelled` (R-18). No active redemption → no-op. */
  release(orderId: string, trx: DbTransaction): Promise<void>;
}

@injectable()
export class CouponRedemptionService implements ICouponRedemptions {
  constructor(
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.CouponRepository) private readonly coupons: CouponRepository,
    @inject(TOKENS.CouponRedemptionRepository) private readonly redemptions: CouponRedemptionRepository,
  ) {}

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
    if (used >= perCustomerLimit) throw couponCustomerLimitReached();
    await this.redemptions.insert(redemption, trx);
  }

  async release(orderId: string, trx: DbTransaction): Promise<void> {
    const redemption = await this.redemptions.findActiveByOrderId(orderId, trx);
    if (!redemption) return;
    await this.redemptions.markReleased(redemption.id, trx);
    await this.coupons.giveUseBack(redemption.couponId, trx);
  }
}
