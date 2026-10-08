/**
 * health module: liveness and readiness probes. Owns no tables.
 * Public API: registration + router factory (used only by the composition root).
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { TOKENS } from '../../lib/di';
import { type OpenApiRegistry } from '../../lib/http';
import { HealthController } from './controller/health.controller';
import { healthRoutes } from './routes';
import { HealthService } from './service/health.service';

export { HEALTH_BASE_PATH } from './routes';

export function registerHealthModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.HealthService, HealthService);
  container.registerSingleton(TOKENS.HealthController, HealthController);
}

export function createHealthRouter(container: DependencyContainer): Router {
  return healthRoutes(
    container.resolve<HealthController>(TOKENS.HealthController),
    container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
  );
}
