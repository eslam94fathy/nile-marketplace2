import { IsEmail, IsString, IsUUID, Length, MaxLength, MinLength } from 'class-validator';
import { BCRYPT_MAX_BYTES } from '../../../pkg/hashing';
import { IsEgyptianMobile, MaxBytes, NormalizeEmail, Trim } from './validators';

/**
 * The DTO shorthands of docs/spec/01-api-conventions.md §1.1, shared by every module's DTOs.
 * Each one is a fixed decorator stack, so a rule is written once.
 */

export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 8;

const stack =
  (...decorators: PropertyDecorator[]): PropertyDecorator =>
  (target, key) => {
    for (const decorator of decorators) decorator(target, key);
  };

/** `uuid`: version 7 only (path params and body ids). */
export const UuidField = () => IsUUID('7');

/** `str(a..b)`: trimmed, then a string of `min..max` characters. */
export const StrField = (min: number, max: number) => stack(Trim(), IsString(), Length(min, max));

/** `email`: trimmed, lower-cased, ≤ 254. */
export const EmailField = () => stack(NormalizeEmail(), IsEmail(), MaxLength(EMAIL_MAX_LENGTH));

/** `password` (a new one): 8 characters minimum, 72 UTF-8 bytes maximum (bcrypt). Never trimmed. */
export const PasswordField = () =>
  stack(IsString(), MinLength(PASSWORD_MIN_LENGTH), MaxBytes(BCRYPT_MAX_BYTES));

/** `phone`: Egyptian mobile in E.164. */
export const PhoneField = () => stack(IsString(), IsEgyptianMobile());
