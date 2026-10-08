import { type ErrorRequestHandler, type Request, type Response } from 'express';
import { getContext } from '../context';
import { type ILogger } from '../logger';
import { buildErrorEnvelope } from '../http/response';
import { routeTemplate } from '../http/route-template';
import { HTTP_STATUS } from '../http/status-codes';
import { type AppError, isAppError } from './app-error';
import { internalError, malformedJson, payloadTooLarge } from './common-errors';
import { type PgErrorMapper } from './pg-error-mapper';

/** body-parser marks its errors with `type`. */
function mapBodyParserError(error: unknown): AppError | undefined {
  const type = (error as { type?: unknown }).type;
  if (type === 'entity.parse.failed') return malformedJson();
  if (type === 'entity.too.large') return payloadTooLarge();
  return undefined;
}

/** 4xx outcomes worth a `warn` line; the rest are visible in the request-completion log. */
const WARN_STATUSES = new Set<number>([
  HTTP_STATUS.UNAUTHORIZED,
  HTTP_STATUS.FORBIDDEN,
  HTTP_STATUS.CONFLICT,
  HTTP_STATUS.UNPROCESSABLE_ENTITY,
  HTTP_STATUS.TOO_MANY_REQUESTS,
]);

function requestFields(req: Request, res: Response): Record<string, unknown> {
  // Never body, headers or cookies (CLAUDE.md §9.2).
  return {
    method: req.method,
    route: routeTemplate(req, res),
    ip: req.ip,
  };
}

/** Global error handler: maps every error to the envelope (CLAUDE.md §7, §9.1). */
export function createErrorHandler(logger: ILogger, pgErrorMapper: PgErrorMapper): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const appError =
      (isAppError(error) ? error : undefined) ??
      mapBodyParserError(error) ??
      pgErrorMapper.map(error) ??
      internalError(error);

    const status = appError.httpStatus;
    if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR) {
      logger.error('request failed', {
        ...requestFields(req, res),
        statusCode: status,
        errorCode: appError.code,
        error: error instanceof Error ? error : String(error),
      });
    } else if (WARN_STATUSES.has(status)) {
      logger.warn('request rejected', {
        ...requestFields(req, res),
        statusCode: status,
        errorCode: appError.code,
      });
    }

    // AppError messages are author-written and safe; unknown errors became the generic INTERNAL_ERROR.
    // Stacks and causes only ever go to the log, never to the client.
    res
      .status(status)
      .json(
        buildErrorEnvelope(
          appError.code,
          appError.message,
          getContext()?.correlationId ?? null,
          appError.details,
        ),
      );
  };
}
