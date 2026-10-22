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
import { type HealthCheck, HealthService } from './service/health.service';

export { HEALTH_BASE_PATH } from './routes';
export { Dependency } from './enums';
export type { HealthCheck } from './service/health.service';

/** `checks`: the dependencies this process needs, each checked with its own timeout. */
export function registerHealthModule(container: DependencyContainer, checks: readonly HealthCheck[]): void {
  container.register(TOKENS.HealthChecks, { useValue: checks });
  container.registerSingleton(TOKENS.HealthService, HealthService);
  container.registerSingleton(TOKENS.HealthController, HealthController);
}

export function createHealthRouter(container: DependencyContainer): Router {
  return healthRoutes(
    container.resolve<HealthController>(TOKENS.HealthController),
    container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
  );
}
