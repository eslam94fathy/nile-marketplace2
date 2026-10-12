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
import { type PgErrorMapper } from '../../lib/error';
import { AgentAdminController, AgentSelfController } from './controller/delivery-agent.controller';
import { DeliverySettingsController } from './controller/delivery-settings.controller';
import { registerDeliveryConstraintErrors } from './errors';
import { DeliveryAgentRepository } from './repository/delivery-agent.repository';
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
export { AgentStatus, ShipmentStatus } from './enums';
export { DeliveryErrorCode } from './errors';

/** api process. Needs Database, Cache, Env, Logger and identity's AccountService. */
export function registerDeliveryModule(container: DependencyContainer): void {
  registerDeliveryConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
  container.registerSingleton(TOKENS.DeliveryAgentRepository, DeliveryAgentRepository);
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
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
