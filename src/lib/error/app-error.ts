import { type HttpStatus } from '../http/status-codes';

export interface ErrorDetail {
  field: string;
  constraint: string;
  message: string;
  value?: string;
}

export interface AppErrorOptions {
  details?: readonly ErrorDetail[];
  /** false = a bug or an infrastructure failure, not an expected business outcome. */
  isOperational?: boolean;
  cause?: unknown;
}

/**
 * The one error type services throw (CLAUDE.md §9.1).
 * Always created through a factory function, never shared as a singleton.
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly details: readonly ErrorDetail[] | undefined;
  readonly isOperational: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: HttpStatus,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.details = options.details;
    this.isOperational = options.isOperational ?? true;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
