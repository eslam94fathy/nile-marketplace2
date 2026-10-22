/**
 * promotions module (docs/spec/19-promotions.md): coupon codes, their quote, redemption and release,
 * and their management by sellers and admins.
 * Owns tables: coupons, coupon_redemptions. No other module reads or writes them.
 * May call: sellers (seller guard, the funding seller's status), catalog (category subtree); audit rows
 * go through lib/audit. Called by cart (preview) and ordering (checkout, close step); calls neither back.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import { type OpenApiRegistry } from '../../lib/http';
import { AdminCouponController, SellerCouponController } from './controller/coupon.controller';
import { registerPromotionsConstraintErrors } from './errors';
import { CouponRedemptionRepository } from './repository/coupon-redemption.repository';
import { CouponRepository } from './repository/coupon.repository';
import { promotionsRoutes } from './routes';
import { CouponManagementService } from './service/coupon-management.service';
import { PromotionsService } from './service/promotions.service';

export {
  CouponDisplayStatus,
  CouponFunding,
  CouponScope,
  CouponStatus,
  DiscountType,
  RedemptionStatus,
} from './enums';
export { PromotionsErrorCode } from './errors';
export type { QuoteLine } from './model/coupon.model';
export type { CouponQuote, IPromotions } from './service/promotions.service';

/** api process. Needs sellers and catalog registered. */
export function registerPromotionsModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.CouponRepository, CouponRepository);
  container.registerSingleton(TOKENS.CouponRedemptionRepository, CouponRedemptionRepository);
  container.registerSingleton(TOKENS.Promotions, PromotionsService);
  container.registerSingleton(TOKENS.CouponManagementService, CouponManagementService);
  container.registerSingleton(TOKENS.SellerCouponController, SellerCouponController);
  container.registerSingleton(TOKENS.AdminCouponController, AdminCouponController);
  registerPromotionsConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createPromotionsRouter(container: DependencyContainer, basePath: string): Router {
  return promotionsRoutes({
    seller: container.resolve<SellerCouponController>(TOKENS.SellerCouponController),
    admin: container.resolve<AdminCouponController>(TOKENS.AdminCouponController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
