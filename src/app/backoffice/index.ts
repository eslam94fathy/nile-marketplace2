/**
 * backoffice module (docs/spec/20-backoffice.md §3): the admin dashboard, composed from the owning
 * modules' stats. Owns no tables; caches one Redis value (`v1:backoffice:dashboard`).
 * May call: ordering, sellers, support, finance, delivery (BO-23; returns joins in R2-P6).
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { TOKENS } from '../../lib/di';
import { type OpenApiRegistry } from '../../lib/http';
import { DashboardController } from './controller/dashboard.controller';
import { backofficeRoutes } from './routes';
import { DashboardService } from './service/dashboard.service';

/** api process. Needs ordering, sellers, support, finance and delivery registered first. */
export function registerBackofficeModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.DashboardService, DashboardService);
  container.registerSingleton(TOKENS.DashboardController, DashboardController);
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createBackofficeRouter(container: DependencyContainer, basePath: string): Router {
  return backofficeRoutes({
    dashboard: container.resolve<DashboardController>(TOKENS.DashboardController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
