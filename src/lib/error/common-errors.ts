import { HTTP_STATUS } from '../http/status-codes';
import { AppError, type ErrorDetail } from './app-error';

/** Shared error codes (docs/spec/01-api-conventions.md §6). Module codes live in each module's errors.ts. */
export const CommonErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_JSON: 'MALFORMED_JSON',
  INVALID_CURSOR: 'INVALID_CURSOR',
  INVALID_QUERY: 'INVALID_QUERY',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  CONFLICT: 'CONFLICT',
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  // Raised by delivery (owner of governorates), customers and sellers (their FKs) [spec 01 v1.2, P2-Q7].
  GOVERNORATE_NOT_FOUND: 'GOVERNORATE_NOT_FOUND',
} as const;

export const validationFailed = (details: readonly ErrorDetail[]) =>
  new AppError(CommonErrorCode.VALIDATION_FAILED, 'Request validation failed', HTTP_STATUS.BAD_REQUEST, {
    details,
  });

export const malformedJson = () =>
  new AppError(CommonErrorCode.MALFORMED_JSON, 'Request body is not valid JSON', HTTP_STATUS.BAD_REQUEST);

export const invalidCursor = () =>
  new AppError(CommonErrorCode.INVALID_CURSOR, 'Cursor is invalid', HTTP_STATUS.BAD_REQUEST);

export const invalidQuery = (details: readonly ErrorDetail[]) =>
  new AppError(CommonErrorCode.INVALID_QUERY, 'Query parameters are invalid', HTTP_STATUS.BAD_REQUEST, {
    details,
  });

export const idempotencyKeyRequired = () =>
  new AppError(
    CommonErrorCode.IDEMPOTENCY_KEY_REQUIRED,
    'A valid Idempotency-Key header is required',
    HTTP_STATUS.BAD_REQUEST,
  );

export const unauthenticated = () =>
  new AppError(CommonErrorCode.UNAUTHENTICATED, 'Authentication required', HTTP_STATUS.UNAUTHORIZED);

export const forbidden = () =>
  new AppError(CommonErrorCode.FORBIDDEN, 'You are not allowed to do this', HTTP_STATUS.FORBIDDEN);

export const routeNotFound = () =>
  new AppError(CommonErrorCode.ROUTE_NOT_FOUND, 'Route not found', HTTP_STATUS.NOT_FOUND);

export const payloadTooLarge = () =>
  new AppError(CommonErrorCode.PAYLOAD_TOO_LARGE, 'Request body is too large', HTTP_STATUS.PAYLOAD_TOO_LARGE);

export const conflict = (cause?: unknown) =>
  new AppError(CommonErrorCode.CONFLICT, 'The resource already exists', HTTP_STATUS.CONFLICT, { cause });

export const idempotencyRequestInProgress = () =>
  new AppError(
    CommonErrorCode.IDEMPOTENCY_REQUEST_IN_PROGRESS,
    'A request with this Idempotency-Key is still being processed',
    HTTP_STATUS.CONFLICT,
  );

export const idempotencyKeyReused = () =>
  new AppError(
    CommonErrorCode.IDEMPOTENCY_KEY_REUSED,
    'This Idempotency-Key was used for a different request',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
  );

export const referenceNotFound = (cause?: unknown) =>
  new AppError(
    CommonErrorCode.REFERENCE_NOT_FOUND,
    'A referenced resource does not exist',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
    { cause },
  );

export const constraintViolation = (cause?: unknown) =>
  new AppError(
    CommonErrorCode.CONSTRAINT_VIOLATION,
    'The request violates a data rule',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
    { cause },
  );

export const rateLimited = () =>
  new AppError(CommonErrorCode.RATE_LIMITED, 'Too many requests', HTTP_STATUS.TOO_MANY_REQUESTS);

export const internalError = (cause?: unknown) =>
  new AppError(CommonErrorCode.INTERNAL_ERROR, 'Something went wrong', HTTP_STATUS.INTERNAL_SERVER_ERROR, {
    cause,
    isOperational: false,
  });

export const serviceUnavailable = (cause?: unknown) =>
  new AppError(
    CommonErrorCode.SERVICE_UNAVAILABLE,
    'The service is temporarily unavailable',
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    { cause, isOperational: false },
  );

/** Governorate named in the path (404). */
export const governorateNotFound = () =>
  new AppError(CommonErrorCode.GOVERNORATE_NOT_FOUND, 'Governorate not found', HTTP_STATUS.NOT_FOUND);

/** Governorate referenced from a request body (422); modules map their governorate FK to this. */
export const governorateReferenceNotFound = (cause?: unknown) =>
  new AppError(
    CommonErrorCode.GOVERNORATE_NOT_FOUND,
    'Governorate not found',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
    { cause },
  );
