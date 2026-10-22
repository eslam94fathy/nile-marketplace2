/**
 * returns module (docs/spec/18-returns.md): return requests of delivered items, the seller's and admins'
 * decisions, and (from R2-P6 step 5) the return shipment's progress and completion.
 * Owns tables: return_requests, return_items, return_photos, return_status_history.
 * No other module reads or writes them.
 * May call: ordering (returnable items, amounts, logistics, recording), inventory (restock), payments
 * (refund status), delivery (fees), media (photos), customers and sellers (the caller's profile, A-11);
 * audit rows go through lib/audit. Read by finance (holding release) and the back-office (stats).
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { type ApiEnv } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import { type OpenApiRegistry } from '../../lib/http';
import { type ILogger } from '../../lib/logger';
import { requireIdempotency } from '../../lib/middleware';
import { type ICache } from '../../pkg/cache';
import { AdminReturnController } from './controller/admin-return.controller';
import { ReturnController } from './controller/return.controller';
import { SellerReturnController } from './controller/seller-return.controller';
import { registerReturnsConstraintErrors } from './errors';
import { ReturnHistoryRepository } from './repository/return-history.repository';
import { ReturnItemRepository } from './repository/return-item.repository';
import { ReturnPhotoRepository } from './repository/return-photo.repository';
import { ReturnRequestRepository } from './repository/return-request.repository';
import { returnRoutes } from './routes';
import { ReturnDecisionService } from './service/return-decision.service';
import { ReturnLifecycleService } from './service/return-lifecycle.service';
import { ReturnRequestService } from './service/return-request.service';
import { ReturnViewService } from './service/return-view.service';

export { ReturnsErrorCode } from './errors';
export { ReturnStatus, ReturnReason, OPEN_RETURN_STATUSES, type OpenReturnStatus } from './enums';

/**
 * api process: the return endpoints (spec 18 §4). Needs ordering, inventory, payments, delivery, media,
 * customers and sellers registered.
 */
export function registerReturnsModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.ReturnRequestRepository, ReturnRequestRepository);
  container.registerSingleton(TOKENS.ReturnItemRepository, ReturnItemRepository);
  container.registerSingleton(TOKENS.ReturnPhotoRepository, ReturnPhotoRepository);
  container.registerSingleton(TOKENS.ReturnHistoryRepository, ReturnHistoryRepository);
  container.registerSingleton(TOKENS.ReturnLifecycleService, ReturnLifecycleService);
  container.registerSingleton(TOKENS.ReturnRequestService, ReturnRequestService);
  container.registerSingleton(TOKENS.ReturnDecisionService, ReturnDecisionService);
  container.registerSingleton(TOKENS.ReturnViewService, ReturnViewService);
  container.registerSingleton(TOKENS.ReturnController, ReturnController);
  container.registerSingleton(TOKENS.SellerReturnController, SellerReturnController);
  container.registerSingleton(TOKENS.AdminReturnController, AdminReturnController);
  registerReturnsConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createReturnsRouter(container: DependencyContainer, basePath: string): Router {
  return returnRoutes({
    customer: container.resolve<ReturnController>(TOKENS.ReturnController),
    seller: container.resolve<SellerReturnController>(TOKENS.SellerReturnController),
    admin: container.resolve<AdminReturnController>(TOKENS.AdminReturnController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    idempotency: requireIdempotency(
      container.resolve<ICache>(TOKENS.Cache),
      container.resolve<ApiEnv>(TOKENS.Env),
      container.resolve<ILogger>(TOKENS.Logger),
    ),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
