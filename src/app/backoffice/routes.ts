import { Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { BACKOFFICE_PATHS as P } from './constants';
import { type DashboardController } from './controller/dashboard.controller';
import { DashboardDto } from './dto/dashboard.dto';

export interface BackofficeRouteDeps {
  dashboard: DashboardController;
  jwtVerifier: JwtVerifier;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 20 §3.2: admin only, general rate limit (applied globally). */
export function backofficeRoutes(deps: BackofficeRouteDeps): Router {
  const { docs, basePath } = deps;
  const router = Router();
  router.get(P.DASHBOARD, authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN), deps.dashboard.get);

  docs.add({
    method: 'get',
    path: `${basePath}${P.DASHBOARD}`,
    summary:
      'The back-office dashboard: open seller orders, orders placed, GMV per Cairo day (30 days, today included), top sellers, pending sellers, support, finance and delivery figures. Cached for DASHBOARD_CACHE_TTL_SECONDS; generatedAt is the computation time',
    tags: ['admin: dashboard'],
    auth: true,
    responses: { 200: { description: 'The dashboard', body: DashboardDto } },
  });
  return router;
}
