import { IsString, Length, MinLength } from 'class-validator';
import { BCRYPT_MAX_BYTES } from '../../../pkg/hashing';
import {
  EmailField,
  IsOtp,
  MaxBytes,
  Optional,
  PasswordField as NewPasswordField,
  Trim,
} from '../../../lib/http';
import { DEVICE_NAME_MAX_LENGTH, OPAQUE_TOKEN_LENGTH } from '../constants';

/*
 * Request DTOs for spec 03 §4.2–§4.9b. Passwords are never trimmed: they are compared byte for byte.
 */

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
