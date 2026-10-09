/**
 * delivery module (docs/spec/11-delivery.md). Phase 2 builds only the reference data:
 * governorates + fees and the agent fee-share setting. Agents and shipments arrive in Phase 6.
 * Owns tables: governorates, delivery_settings (later also delivery_agents, shipments,
 * shipment_attempts, shipment_status_history). No other module reads or writes them; customers and
 * sellers reference `governorates` through FKs only (D12).
 * May call: identity (from Phase 6). This file is its only public surface.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { TOKENS } from '../../lib/di';
import { type OpenApiRegistry } from '../../lib/http';
import { DeliverySettingsController } from './controller/delivery-settings.controller';
import { GovernorateController } from './controller/governorate.controller';
import { DeliverySettingsRepository } from './repository/delivery-settings.repository';
import { GovernorateRepository } from './repository/governorate.repository';
import { deliveryRoutes } from './routes';
import { DeliveryReferenceService } from './service/delivery-reference.service';
import { DeliverySettingsService } from './service/delivery-settings.service';
import { GovernorateService } from './service/governorate.service';

/** Inject with `TOKENS.DeliveryReferenceService`. */
export type { IDeliveryReferenceService, GovernorateFee } from './service/delivery-reference.service';

/** api process. Needs Database, Cache, Env and Logger. */
export function registerDeliveryModule(container: DependencyContainer): void {
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
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
