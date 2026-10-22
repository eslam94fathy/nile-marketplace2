/**
 * sellers module (docs/spec/05-sellers.md): self-registration, profile + pickup address, approval
 * lifecycle, per-seller and default commission.
 * Owns tables: sellers, seller_status_history, seller_commission_history, seller_settings.
 * No other module reads or writes them. May call: identity. This file is its only public surface.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import { type EventHandlerDefinition, readRatingProjection, ReviewRatingChanged } from '../../lib/events';
import { type OpenApiRegistry } from '../../lib/http';
import { type RateLimiters } from '../../lib/middleware';
import { SellerAdminController } from './controller/seller-admin.controller';
import { SELLERS_RATING_PROJECTION_QUEUE } from './constants';
import { SellerController } from './controller/seller.controller';
import { registerSellersConstraintErrors } from './errors';
import { SellerCommissionHistoryRepository } from './repository/seller-commission-history.repository';
import { SellerSettingsRepository } from './repository/seller-settings.repository';
import { SellerStatusHistoryRepository } from './repository/seller-status-history.repository';
import { SellerRepository } from './repository/seller.repository';
import { sellersRoutes } from './routes';
import { SellerAdminService } from './service/seller-admin.service';
import { SellerDirectory } from './service/seller-directory.service';
import { SellerRatingProjectionService } from './service/seller-rating-projection.service';
import { SellerService } from './service/seller.service';

export { SellerStatus } from './enums';
/** `sellerNotApproved` is for other modules' guards (catalog writes, spec 05 §6). */
export { SellersErrorCode, sellerNotApproved } from './errors';
/** Inject with `TOKENS.SellerDirectory`. */
export type {
  ISellerDirectory,
  SellerCheckoutSnapshot,
  SellerLookupOptions,
  SellerStatusSummary,
  SellerSummary,
} from './service/seller-directory.service';

/** api process. Needs identity's AccountService registered first. */
/** worker process: the rating projection (spec 05 §8.1) and the public lookups. */
export function registerSellersWorker(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.SellerRepository, SellerRepository);
  container.registerSingleton(TOKENS.SellerRatingProjectionService, SellerRatingProjectionService);
}

/** The public lookups only (`ISellerDirectory`), for the realtime gateway. */
export function registerSellersLookups(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.SellerRepository, SellerRepository);
  container.registerSingleton(TOKENS.SellerDirectory, SellerDirectory);
}

export function registerSellersModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.SellerRepository, SellerRepository);
  container.registerSingleton(TOKENS.SellerStatusHistoryRepository, SellerStatusHistoryRepository);
  container.registerSingleton(TOKENS.SellerSettingsRepository, SellerSettingsRepository);
  container.registerSingleton(TOKENS.SellerCommissionHistoryRepository, SellerCommissionHistoryRepository);
  container.registerSingleton(TOKENS.SellerService, SellerService);
  container.registerSingleton(TOKENS.SellerDirectory, SellerDirectory);
  container.registerSingleton(TOKENS.SellerAdminService, SellerAdminService);
  container.registerSingleton(TOKENS.SellerController, SellerController);
  container.registerSingleton(TOKENS.SellerAdminController, SellerAdminController);
  registerSellersConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createSellersRouter(container: DependencyContainer, basePath: string): Router {
  return sellersRoutes({
    sellers: container.resolve<SellerController>(TOKENS.SellerController),
    admin: container.resolve<SellerAdminController>(TOKENS.SellerAdminController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    rateLimiters: container.resolve<RateLimiters>(TOKENS.RateLimiters),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}

/**
 * Consumer `sellers.rating-projection` ← `review.rating_changed` (spec 05 §8.1): the seller part of the
 * aggregate, applied only when newer. Dedupe through `processed_events` as every consumer.
 */
export function createSellersHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  const ratings = container.resolve<SellerRatingProjectionService>(TOKENS.SellerRatingProjectionService);
  return [
    {
      name: SELLERS_RATING_PROJECTION_QUEUE,
      events: [ReviewRatingChanged],
      handle: (envelope, trx) => {
        const { subjectId, projection } = readRatingProjection(envelope, 'seller');
        return ratings.apply(subjectId, projection, trx);
      },
    },
  ];
}
