import { type AppError } from './app-error';
import { conflict, constraintViolation, referenceNotFound } from './common-errors';

/** Postgres SQLSTATE codes we map (CLAUDE.md §9.1). */
export const PgErrorCode = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
} as const;

type ConstraintErrorFactory = (cause: unknown) => AppError;

interface PgLikeError {
  code: string;
  constraint?: string;
}

function isPgError(error: unknown): error is PgLikeError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((error as { code: string }).code)
  );
}

/**
 * Translates database constraint violations into domain errors.
 * Modules register their constraint names (e.g. `uq_users_email` → EMAIL_ALREADY_REGISTERED),
 * because a check-then-insert can always race (CLAUDE.md §6.4).
 */
export class PgErrorMapper {
  private readonly byConstraint = new Map<string, ConstraintErrorFactory>();

  register(constraintName: string, factory: ConstraintErrorFactory): void {
    if (this.byConstraint.has(constraintName)) {
      throw new Error(`Constraint "${constraintName}" is already registered`);
    }
    this.byConstraint.set(constraintName, factory);
  }

  /** Returns a mapped AppError, or undefined when the error isn't a constraint violation. */
  map(error: unknown): AppError | undefined {
    if (!isPgError(error)) return undefined;
    const registered = error.constraint ? this.byConstraint.get(error.constraint) : undefined;
    if (registered) return registered(error);
    switch (error.code) {
      case PgErrorCode.UNIQUE_VIOLATION:
        return conflict(error);
      case PgErrorCode.FOREIGN_KEY_VIOLATION:
        return referenceNotFound(error);
      case PgErrorCode.CHECK_VIOLATION:
        return constraintViolation(error);
      default:
        return undefined;
    }
  }
}
