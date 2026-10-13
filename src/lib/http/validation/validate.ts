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
 * Keys that address an object's prototype. class-transformer drops them silently; they are rejected
 * like any unknown key (CLAUDE.md §7, P8 security review F-5).
 */
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function prototypeKeyPaths(value: unknown, path: string, found: string[]): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => prototypeKeyPaths(item, childPath(path, String(index)), found));
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      const field = childPath(path, key);
      if (PROTOTYPE_KEYS.has(key)) found.push(field);
      else prototypeKeyPaths((value as Record<string, unknown>)[key], field, found);
    }
  }
  return found;
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
  const forbidden = prototypeKeyPaths(input, '', []);
  if (forbidden.length > 0) {
    throw validationFailed(
      forbidden.map((field) => ({ field, constraint: 'forbiddenKey', message: 'this key is not allowed' })),
    );
  }
  const instance = plainToInstance(dtoClass, input, {
    enableImplicitConversion: false,
    exposeDefaultValues: false,
  });
  const errors = await runValidation(instance, STRICT_VALIDATOR_OPTIONS);
  if (errors.length > 0) throw validationFailed(toErrorDetails(errors));
  return instance;
}
