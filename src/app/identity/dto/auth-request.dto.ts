import { IsEmail, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { BCRYPT_MAX_BYTES } from '../../../pkg/hashing';
import { IsOtp, MaxBytes, NormalizeEmail, Optional, Trim } from '../../../lib/http';
import {
  DEVICE_NAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  OPAQUE_TOKEN_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../constants';

/*
 * Request DTOs for spec 03 §4.2–§4.9b. Passwords are never trimmed: they are compared byte for byte.
 */

/** `email` shorthand: trimmed, lower-cased, ≤ 254. */
function EmailField(): PropertyDecorator {
  return (target, key) => {
    NormalizeEmail()(target, key);
    IsEmail()(target, key);
    MaxLength(EMAIL_MAX_LENGTH)(target, key);
  };
}

/** `password` shorthand: 8 characters minimum, 72 UTF-8 bytes maximum (bcrypt). */
function NewPasswordField(): PropertyDecorator {
  return (target, key) => {
    IsString()(target, key);
    MinLength(PASSWORD_MIN_LENGTH)(target, key);
    MaxBytes(BCRYPT_MAX_BYTES)(target, key);
  };
}

/** An existing password: no policy check, only the bcrypt limit. */
function CurrentPasswordField(): PropertyDecorator {
  return (target, key) => {
    IsString()(target, key);
    MinLength(1)(target, key);
    MaxBytes(BCRYPT_MAX_BYTES)(target, key);
  };
}

function OpaqueTokenField(): PropertyDecorator {
  return (target, key) => {
    IsString()(target, key);
    Length(OPAQUE_TOKEN_LENGTH, OPAQUE_TOKEN_LENGTH)(target, key);
  };
}

export class VerifyEmailDto {
  @EmailField()
  email!: string;

  @IsOtp()
  otp!: string;
}

export class EmailOnlyDto {
  @EmailField()
  email!: string;
}

export class LoginDto {
  @EmailField()
  email!: string;

  @CurrentPasswordField()
  password!: string;

  @Optional()
  @Trim()
  @IsString()
  @Length(1, DEVICE_NAME_MAX_LENGTH)
  deviceName?: string;
}

export class RefreshTokenDto {
  @OpaqueTokenField()
  refreshToken!: string;
}

export class ResetPasswordDto {
  @EmailField()
  email!: string;

  @IsOtp()
  otp!: string;

  @NewPasswordField()
  newPassword!: string;
}

export class AcceptInviteDto {
  @OpaqueTokenField()
  token!: string;

  @NewPasswordField()
  password!: string;
}

export class ChangePasswordDto {
  @CurrentPasswordField()
  currentPassword!: string;

  @NewPasswordField()
  newPassword!: string;

  @OpaqueTokenField()
  refreshToken!: string;
}
