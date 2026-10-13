import { Transform } from 'class-transformer';
import {
  Matches,
  ValidateBy,
  ValidateIf,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/**
 * Custom validators used by DTOs (docs/spec/01-api-conventions.md §1.1).
 * Patterns are exported so the OpenAPI generator and tests share them.
 */
export const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
/** MONEY_PATTERN, excluding zero ("0", "0.0", "00.00"…). */
export const POSITIVE_MONEY_PATTERN = /^(?!0+(\.0{1,2})?$)\d{1,10}(\.\d{1,2})?$/;
export const RATE_PATTERN = /^(0(\.\d{1,4})?|1(\.0{1,4})?)$/;
export const EGYPTIAN_MOBILE_PATTERN = /^\+20(10|11|12|15)\d{8}$/;
export const OTP_PATTERN = /^\d{6}$/;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Decimal string that fits NUMERIC(12,2), e.g. "150.00". */
export const IsMoney = (options?: ValidationOptions) =>
  Matches(MONEY_PATTERN, { message: '$property must be a decimal string with up to 2 decimals', ...options });

/** `money, > 0` (e.g. a variant price). */
export const IsPositiveMoney = (options?: ValidationOptions) =>
  Matches(POSITIVE_MONEY_PATTERN, {
    message: '$property must be a decimal string greater than 0 with up to 2 decimals',
    ...options,
  });

/** Decimal string between 0 and 1 with up to 4 decimals, e.g. "0.1000". */
export const IsRate = (options?: ValidationOptions) =>
  Matches(RATE_PATTERN, { message: '$property must be a decimal string between 0 and 1', ...options });

export const IsEgyptianMobile = (options?: ValidationOptions) =>
  Matches(EGYPTIAN_MOBILE_PATTERN, {
    message: '$property must be an Egyptian mobile number in E.164 format (+20…)',
    ...options,
  });

export const IsOtp = (options?: ValidationOptions) =>
  Matches(OTP_PATTERN, { message: '$property must be 6 digits', ...options });

export const IsSlug = (options?: ValidationOptions) =>
  Matches(SLUG_PATTERN, { message: '$property must be lower-case kebab-case', ...options });

/** UTF-8 byte length limit (bcrypt only reads the first 72 bytes, CLAUDE.md §10). */
export function MaxBytes(max: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'maxBytes',
      constraints: [max],
      validator: {
        validate: (value: unknown) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max,
        defaultMessage: () => `$property must be at most ${max} bytes`,
      },
    },
    options,
  );
}

/** Name of the hidden property that carries the PATCH rule; reported to clients as `(body)`. */
export const PATCH_RULE_PROPERTY = '__atLeastOneField';

/**
 * Base class for PATCH DTOs: an empty body is a validation error (docs/spec/01-api-conventions.md §1.1).
 * The rule sits on a hidden, never-optional property, because class-validator skips every validator
 * of an `@IsOptional` property whose value is missing, which is exactly the empty-body case.
 */
export abstract class PatchDto {
  @ValidateBy({
    name: 'atLeastOneField',
    validator: {
      validate: (value: unknown, args: ValidationArguments) =>
        value === undefined &&
        Object.entries(args.object).some(
          ([key, fieldValue]) => key !== PATCH_RULE_PROPERTY && fieldValue !== undefined,
        ),
      defaultMessage: () => 'at least one field must be provided',
    },
  })
  readonly [PATCH_RULE_PROPERTY]?: never;
}

/**
 * `opt` in the spec notation (docs/spec/01-api-conventions.md §1.1): the field may be absent, but an
 * explicit `null` is still validated (and rejected). `@IsOptional` would let `null` through.
 */
export const Optional = () => ValidateIf((_object: object, value: unknown) => value !== undefined);

/**
 * `nullable` in the spec notation: an explicit `null` is accepted and skips the other validators.
 * A missing field is still validated (and rejected) unless `@Optional()` is stacked on top.
 */
export const Nullable = () => ValidateIf((_object: object, value: unknown) => value !== null);

/** Trims strings before validation; non-strings pass through untouched (and fail @IsString). */
export const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** Trims and lower-cases emails before validation. */
export const NormalizeEmail = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
