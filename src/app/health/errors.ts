import { AppError, CommonErrorCode, type ErrorDetail } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** 503 with one detail per dependency that is down (no versions, no internals). */
export const dependenciesUnavailable = (details: readonly ErrorDetail[]) =>
  new AppError(CommonErrorCode.SERVICE_UNAVAILABLE, 'Not ready', HTTP_STATUS.SERVICE_UNAVAILABLE, {
    details,
  });
