import { type RequestHandler } from 'express';
import { type IClock } from '../clock';
import { requestPath, routeTemplate } from '../http/route-template';
import { type ILogger } from '../logger';

/** One completion line per request: method, route template, status, duration (CLAUDE.md §9.2). */
export function requestLogger(
  logger: ILogger,
  clock: IClock,
  quietPathPrefixes: readonly string[],
): RequestHandler {
  return (req, res, next) => {
    const startedAt = clock.now().getTime();
    res.on('finish', () => {
      const fields = {
        method: req.method,
        route: routeTemplate(req, res),
        statusCode: res.statusCode,
        durationMs: clock.now().getTime() - startedAt,
        userId: req.auth?.userId,
        ip: req.ip,
      };
      // Probes hit health endpoints every few seconds; keep them out of normal logs.
      const path = requestPath(req);
      if (quietPathPrefixes.some((prefix) => path.startsWith(prefix)))
        logger.debug('request completed', fields);
      else logger.info('request completed', fields);
    });
    next();
  };
}
