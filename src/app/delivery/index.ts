/**
 * delivery module (docs/spec/11-delivery.md): governorates + fees, the agent fee-share setting,
 * delivery agents, shipments and their assignment.
 * Owns tables: governorates, delivery_settings, delivery_agents, shipments, shipment_attempts,
 * shipment_status_history. No other module reads or writes them; customers, sellers and ordering
 * reference `governorates` through FKs only (D12).
 * May call: identity (agent logins). Reacts to ordering's events and never calls ordering.
 * This file is its only public surface.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { TOKENS } from '../../lib/di';
import { type OpenApiRegistry } from '../../lib/http';
import { type ApiEnv, type Env } from '../../lib/config';
import { type ILogger } from '../../lib/logger';
import { requireIdempotency } from '../../lib/middleware';
import { type ICache } from '../../pkg/cache';
import { type PgErrorMapper } from '../../lib/error';
import {
  type EventHandlerDefinition,
  SellerOrderCancelled,
  SellerOrderItemsCancelled,
  SellerOrderReadyForPickup,
  SellerOrderReturned,
} from '../../lib/events';
import { type JobDefinition } from '../../lib/jobs';
import { SELLER_ORDER_UPDATES_QUEUE } from './constants';
import { AgentAdminController, AgentSelfController } from './controller/delivery-agent.controller';
import { DeliverySettingsController } from './controller/delivery-settings.controller';
import { registerDeliveryConstraintErrors } from './errors';
import { ShipmentAdminController } from './controller/shipment-admin.controller';
import { AgentShipmentController } from './controller/agent-shipment.controller';
import { ShipmentWorkService } from './service/shipment-work.service';
import { DeliveryAgentRepository } from './repository/delivery-agent.repository';
import { ShipmentHistoryRepository } from './repository/shipment-history.repository';
import { ShipmentRepository } from './repository/shipment.repository';
import { AssignmentRetryJob } from './service/assignment-retry.job';
import { SellerOrderUpdateService } from './service/seller-order-update.service';
import { ShipmentAssignmentService } from './service/shipment-assignment.service';
import { ShipmentDirectory } from './service/shipment-directory.service';
import { ShipmentViewService } from './service/shipment-view.service';
import { DeliveryAgentDirectory } from './service/delivery-agent-directory.service';
import { DeliveryAgentService } from './service/delivery-agent.service';
import { GovernorateController } from './controller/governorate.controller';
import { DeliverySettingsRepository } from './repository/delivery-settings.repository';
import { GovernorateRepository } from './repository/governorate.repository';
import { deliveryRoutes } from './routes';
import { DeliveryReferenceService } from './service/delivery-reference.service';
import { DeliverySettingsService } from './service/delivery-settings.service';
import { GovernorateService } from './service/governorate.service';

/** Inject with `TOKENS.DeliveryReferenceService`. */
export type { IDeliveryReferenceService, GovernorateFee } from './service/delivery-reference.service';
/** Inject with `TOKENS.DeliveryAgentDirectory` (finance). */
export type { IDeliveryAgentDirectory } from './service/delivery-agent-directory.service';
/** Inject with `TOKENS.ShipmentDirectory` (backoffice). */
export type { DeliveryDashboardStats, IShipmentDirectory } from './service/shipment-directory.service';
export { AgentStatus, ShipmentStatus } from './enums';
export { DeliveryErrorCode } from './errors';

/** What both processes need: the agent and shipment repositories and the assignment service. */
function registerDeliveryCore(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.DeliveryAgentRepository, DeliveryAgentRepository);
  container.registerSingleton(TOKENS.ShipmentRepository, ShipmentRepository);
  container.registerSingleton(TOKENS.ShipmentHistoryRepository, ShipmentHistoryRepository);
  container.registerSingleton(TOKENS.ShipmentAssignmentService, ShipmentAssignmentService);
}

/** worker process: the seller-order consumer and the assignment retry job (DE-13). No identity. */
export function registerDeliveryWorker(container: DependencyContainer): void {
  registerDeliveryCore(container);
  container.registerSingleton(TOKENS.SellerOrderUpdateService, SellerOrderUpdateService);
  container.registerSingleton(TOKENS.AssignmentRetryJob, AssignmentRetryJob);
}

/** Consumer `delivery.seller-order-updates` (spec 11 UC-DE-1, UC-DE-5, spec 02 §2). */
export function createDeliveryHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  const updates = container.resolve<SellerOrderUpdateService>(TOKENS.SellerOrderUpdateService);
  return [
    {
      name: SELLER_ORDER_UPDATES_QUEUE,
      events: [
        SellerOrderReadyForPickup,
        SellerOrderItemsCancelled,
        SellerOrderCancelled,
        SellerOrderReturned,
      ],
      handle: (envelope, trx) => updates.handle(envelope, trx),
    },
  ];
}

/** The delivery jobs (DE-9), on a container with the delivery worker registered. */
export function createDeliveryJobs(
  container: DependencyContainer,
  env: Pick<Env, 'JOB_SHIPMENT_ASSIGNMENT_RETRY_INTERVAL_MS' | 'SHIPMENT_JOBS_BATCH_SIZE'>,
): JobDefinition[] {
  const retry = container.resolve<AssignmentRetryJob>(TOKENS.AssignmentRetryJob);
  return [
    {
      name: 'shipment-assignment-retry',
      intervalMs: env.JOB_SHIPMENT_ASSIGNMENT_RETRY_INTERVAL_MS,
      run: () => retry.run(env.SHIPMENT_JOBS_BATCH_SIZE),
    },
  ];
}

/** api process. Needs Database, Cache, Env, Logger and identity's AccountService. */
/** The agent lookups only (`IDeliveryAgentDirectory`), for the realtime gateway and the worker. */
export function registerDeliveryAgentLookups(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.DeliveryAgentRepository, DeliveryAgentRepository);
  container.registerSingleton(TOKENS.DeliveryAgentDirectory, DeliveryAgentDirectory);
}

export function registerDeliveryModule(container: DependencyContainer): void {
  registerDeliveryConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
  registerDeliveryCore(container);
  container.registerSingleton(TOKENS.ShipmentViewService, ShipmentViewService);
  container.registerSingleton(TOKENS.ShipmentDirectory, ShipmentDirectory);
  container.registerSingleton(TOKENS.ShipmentAdminController, ShipmentAdminController);
  container.registerSingleton(TOKENS.ShipmentWorkService, ShipmentWorkService);
  container.registerSingleton(TOKENS.AgentShipmentController, AgentShipmentController);
  container.registerSingleton(TOKENS.DeliveryAgentService, DeliveryAgentService);
  container.registerSingleton(TOKENS.DeliveryAgentDirectory, DeliveryAgentDirectory);
  container.registerSingleton(TOKENS.AgentSelfController, AgentSelfController);
  container.registerSingleton(TOKENS.AgentAdminController, AgentAdminController);
  container.registerSingleton(TOKENS.GovernorateRepository, GovernorateRepository);
  container.registerSingleton(TOKENS.DeliverySettingsRepository, DeliverySettingsRepository);
  container.registerSingleton(TOKENS.GovernorateService, GovernorateService);
  container.registerSingleton(TOKENS.DeliverySettingsService, DeliverySettingsService);
  container.registerSingleton(TOKENS.DeliveryReferenceService, DeliveryReferenceService);
  container.registerSingleton(TOKENS.GovernorateController, GovernorateController);
  container.registerSingleton(TOKENS.DeliverySettingsController, DeliverySettingsController);
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createDeliveryRouter(container: DependencyContainer, basePath: string): Router {
  return deliveryRoutes({
    governorates: container.resolve<GovernorateController>(TOKENS.GovernorateController),
    settings: container.resolve<DeliverySettingsController>(TOKENS.DeliverySettingsController),
    agentSelf: container.resolve<AgentSelfController>(TOKENS.AgentSelfController),
    agentAdmin: container.resolve<AgentAdminController>(TOKENS.AgentAdminController),
    shipmentAdmin: container.resolve<ShipmentAdminController>(TOKENS.ShipmentAdminController),
    agentShipments: container.resolve<AgentShipmentController>(TOKENS.AgentShipmentController),
    idempotency: requireIdempotency(
      container.resolve<ICache>(TOKENS.Cache),
      container.resolve<ApiEnv>(TOKENS.Env),
      container.resolve<ILogger>(TOKENS.Logger),
    ),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
