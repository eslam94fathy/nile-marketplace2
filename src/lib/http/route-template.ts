import { type Request, type RequestHandler, type Response } from 'express';

const MOUNT_PATH_KEY = 'mountPath';

/**
 * Express resets `req.baseUrl` once a router is left (e.g. before the global error handler runs),
 * so each mounted router records its mount path here when it is entered.
 */
export function recordMountPath(): RequestHandler {
  return (req, res, next) => {
    res.locals[MOUNT_PATH_KEY] = req.baseUrl;
    next();
  };
}

/** Route template (`/api/v1/orders/:orderId`), never the raw URL: ids and query strings stay out of logs. */
export function routeTemplate(req: Request, res: Response): string {
  const route = req.route as { path?: unknown } | undefined;
  if (typeof route?.path !== 'string') return 'unmatched';
  const mountPath: unknown = res.locals[MOUNT_PATH_KEY];
  return `${typeof mountPath === 'string' ? mountPath : req.baseUrl}${route.path}`;
}

/** Path of the original request URL without the query string. */
export function requestPath(req: Request): string {
  return req.originalUrl.split('?', 1)[0] ?? '';
}
