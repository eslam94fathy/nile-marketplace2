/**
 * returns module (docs/spec/18-returns.md): return requests of delivered items, the seller's and admins'
 * decisions, the return shipment's progress, completion, disputes and the deadline jobs.
 * Owns tables: return_requests, return_items, return_photos, return_status_history.
 * No other module reads or writes them.
 * May call: ordering (returnable items, amounts, logistics, recording), inventory (restock), payments
 * (refund status), delivery (fees), media (photos), customers and sellers (the caller's profile, A-11);
 * audit rows go through lib/audit. Read by finance (holding release) and the back-office (stats).
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { type ApiEnv, type Env } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import {
  type EventHandlerDefinition,
  ReturnShipmentDelivered,
  ReturnShipmentFailed,
  ReturnShipmentPickedUp,
} from '../../lib/events';
import { type OpenApiRegistry } from '../../lib/http';
import { type JobDefinition } from '../../lib/jobs';
import { type ILogger } from '../../lib/logger';
import { requireIdempotency } from '../../lib/middleware';
import { type ICache } from '../../pkg/cache';
import { AdminReturnController } from './controller/admin-return.controller';
import { ReturnController } from './controller/return.controller';
import { SellerReturnController } from './controller/seller-return.controller';
import { SHIPMENT_UPDATES_QUEUE } from './constants';
import { registerReturnsConstraintErrors } from './errors';
import { ReturnHistoryRepository } from './repository/return-history.repository';
import { ReturnItemRepository } from './repository/return-item.repository';
import { ReturnPhotoRepository } from './repository/return-photo.repository';
import { ReturnRequestRepository } from './repository/return-request.repository';
import { returnRoutes } from './routes';
import { ReturnCompletionService } from './service/return-completion.service';
import { ReturnDecisionService } from './service/return-decision.service';
import { ReturnJobs } from './service/return-jobs.job';
import { ReturnLifecycleService } from './service/return-lifecycle.service';
import { ReturnRequestService } from './service/return-request.service';
import { ReturnShipmentUpdateService } from './service/return-shipment-update.service';
import { ReturnsDirectory } from './service/returns-directory.service';
import { ReturnViewService } from './service/return-view.service';

export { ReturnsErrorCode } from './errors';
export { ReturnStatus, ReturnReason, OPEN_RETURN_STATUSES, type OpenReturnStatus } from './enums';
/** Inject with `TOKENS.ReturnsDirectory` (finance, backoffice). */
export type { IReturnsDirectory, ReturnsDashboardStats } from './service/returns-directory.service';

/** What both processes need: the repositories, the transition path and the completion (UC-RE-7). */
function registerReturnsCore(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.ReturnRequestRepository, ReturnRequestRepository);
  container.registerSingleton(TOKENS.ReturnItemRepository, ReturnItemRepository);
  container.registerSingleton(TOKENS.ReturnPhotoRepository, ReturnPhotoRepository);
  container.registerSingleton(TOKENS.ReturnHistoryRepository, ReturnHistoryRepository);
  container.registerSingleton(TOKENS.ReturnLifecycleService, ReturnLifecycleService);
  container.registerSingleton(TOKENS.ReturnCompletionService, ReturnCompletionService);
  container.registerSingleton(TOKENS.ReturnsDirectory, ReturnsDirectory);
}

/**
 * api process: the return endpoints (spec 18 §4). Needs ordering, inventory, payments, delivery, media,
 * customers and sellers registered.
 */
export function registerReturnsModule(container: DependencyContainer): void {
  registerReturnsCore(container);
  container.registerSingleton(TOKENS.ReturnRequestService, ReturnRequestService);
  container.registerSingleton(TOKENS.ReturnDecisionService, ReturnDecisionService);
  container.registerSingleton(TOKENS.ReturnViewService, ReturnViewService);
  container.registerSingleton(TOKENS.ReturnController, ReturnController);
  container.registerSingleton(TOKENS.SellerReturnController, SellerReturnController);
  container.registerSingleton(TOKENS.AdminReturnController, AdminReturnController);
  registerReturnsConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}

/** worker process: the shipment consumer and the jobs (spec 18 UC-RE-6, UC-RE-9). Needs ordering and inventory. */
export function registerReturnsWorker(container: DependencyContainer): void {
  registerReturnsCore(container);
  container.registerSingleton(TOKENS.ReturnShipmentUpdateService, ReturnShipmentUpdateService);
  container.registerSingleton(TOKENS.ReturnJobs, ReturnJobs);
}

/** Consumer `returns.shipment-updates` (spec 18 UC-RE-6, spec 02). */
export function createReturnsHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  const updates = container.resolve<ReturnShipmentUpdateService>(TOKENS.ReturnShipmentUpdateService);
  return [
    {
      name: SHIPMENT_UPDATES_QUEUE,
      events: [ReturnShipmentPickedUp, ReturnShipmentDelivered, ReturnShipmentFailed],
      handle: (envelope, trx) => updates.handle(envelope, trx),
    },
  ];
}

/** `returns-jobs` (UC-RE-9): decision timeout, escalation lapse, inspection timeout, one advisory lock. */
export function createReturnsJobs(
  container: DependencyContainer,
  env: Pick<Env, 'JOB_RETURNS_INTERVAL_MS'>,
): JobDefinition[] {
  const jobs = container.resolve<ReturnJobs>(TOKENS.ReturnJobs);
  return [{ name: 'returns-jobs', intervalMs: env.JOB_RETURNS_INTERVAL_MS, run: () => jobs.run() }];
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
