import { type ClassConstructor, plainToInstance } from 'class-transformer';
import { validate as runValidation, type ValidationError, type ValidatorOptions } from 'class-validator';
import { type ErrorDetail } from '../../error/app-error';
import { validationFailed } from '../../error/common-errors';
import { PATCH_RULE_PROPERTY } from './validators';

/** Strict options from CLAUDE.md §7: unknown keys are rejected, never silently stripped. */
export const STRICT_VALIDATOR_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  validationError: { target: false, value: false },
};

function childPath(parent: string, property: string): string {
  if (/^\d+$/.test(property)) return `${parent}[${property}]`;
  return parent ? `${parent}.${property}` : property;
}

/** Flattens nested class-validator errors into `{ field, constraint, message }` (field = `items[0].price`). */
export function toErrorDetails(errors: readonly ValidationError[], parentPath = ''): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  for (const error of errors) {
    const field = childPath(parentPath, error.property);
    for (const [constraint, message] of Object.entries(error.constraints ?? {})) {
      const reportedField = field === PATCH_RULE_PROPERTY || !field ? '(body)' : field;
      details.push({ field: reportedField, constraint, message });
    }
    if (error.children && error.children.length > 0) {
      details.push(...toErrorDetails(error.children, field));
    }
  }
  return details;
}

/**
 * Turns untrusted input into a validated DTO instance, or throws VALIDATION_FAILED.
 * No implicit type conversion: DTOs declare `@Type` explicitly (CLAUDE.md §7).
 */
export async function validateDto<T extends object>(
  dtoClass: ClassConstructor<T>,
  input: unknown,
): Promise<T> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw validationFailed([{ field: '(body)', constraint: 'isObject', message: 'must be a JSON object' }]);
  }
  const instance = plainToInstance(dtoClass, input, {
    enableImplicitConversion: false,
    exposeDefaultValues: false,
  });
  const errors = await runValidation(instance, STRICT_VALIDATOR_OPTIONS);
  if (errors.length > 0) throw validationFailed(toErrorDetails(errors));
  return instance;
}
