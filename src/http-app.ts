import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { type DependencyContainer } from 'tsyringe';
import { createHealthRouter, HEALTH_BASE_PATH } from './app/health';
import { createErrorHandler } from './lib/error';
import { createDocsRouter, recordMountPath } from './lib/http';
import { byIp, correlationId, notFound, RateLimitClass, requestLogger } from './lib/middleware';
import { type Infrastructure } from './infrastructure';

export const API_BASE_PATH = '/api/v1';
export const DOCS_PATH = `${API_BASE_PATH}/docs`;
/** Needs the raw body for signature verification (architecture §4, §7.2). */
export const KASHIER_WEBHOOK_PATH = `${API_BASE_PATH}/webhooks/kashier`;

const API_INFO = { title: 'Nile Marketplace API', version: '1.0.0' } as const;
const BYTES_PER_KB = 1024;

export interface AppOptions {
  /** Extra routers mounted before the 404 handler. Test-only routes (e.g. `/__test`) come in through here. */
  extraRouters?: readonly { path: string; router: Router }[];
}

/** The Express pipeline, in the order of architecture §4. */
export function createApp(
  infra: Infrastructure,
  container: DependencyContainer,
  options: AppOptions = {},
): Express {
  const { env, logger, clock } = infra;
  const app = express();

  // 1. Proxy trust, security headers, no fingerprinting, strict query parsing (keys stay literal: `a[gte]`).
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.set('query parser', 'simple');
  app.disable('x-powered-by');
  app.use(helmet());

  // 2–3. Correlation id (AsyncLocalStorage), then one completion log per request.
  app.use(correlationId());
  app.use(requestLogger(logger, clock, [HEALTH_BASE_PATH]));

  // 4. CORS allow-list (mostly irrelevant for the mobile app).
  app.use(cors({ origin: [...env.CORS_ALLOWED_ORIGINS] }));

  // 5. Raw body for the Kashier webhook, JSON for everything else.
  const bodyLimit = env.HTTP_BODY_LIMIT_KB * BYTES_PER_KB;
  app.use(KASHIER_WEBHOOK_PATH, express.raw({ type: '*/*', limit: bodyLimit }));
  app.use(express.json({ limit: bodyLimit }));

  // Health probes are not rate limited (architecture §4).
  app.use(HEALTH_BASE_PATH, recordMountPath(), createHealthRouter(container));

  // 6. Global rate limit for the API.
  app.use(API_BASE_PATH, infra.rateLimiters.limit(RateLimitClass.GENERAL, byIp));

  // 7. Routes.
  if (env.API_DOCS_ENABLED) app.use(DOCS_PATH, recordMountPath(), createDocsRouter(infra.openApi, API_INFO));
  for (const { path, router } of options.extraRouters ?? []) app.use(path, recordMountPath(), router);

  // 8. 404, then the global error handler.
  app.use(notFound());
  app.use(createErrorHandler(logger, infra.pgErrorMapper));
  return app;
}
