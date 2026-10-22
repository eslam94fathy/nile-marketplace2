import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsISO8601, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { UserRole } from '../../../lib/auth';
import { UserStatus } from '../enums';
import { type User } from '../model/user.model';
import { type SessionTokens } from '../service/token.service';

/*
 * Response DTOs (spec 03 §4.1). The decorators only describe the shape for the OpenAPI document;
 * responses are built by the mappers below, never from a raw model.
 */

export class AuthUserDto {
  @IsUUID()
  id!: string;

  @IsEmail()
  email!: string;

  @IsIn(Object.values(UserRole))
  role!: UserRole;

  @IsIn(Object.values(UserStatus))
  status!: UserStatus;
}

export class AuthTokensDto {
  @IsString()
  accessToken!: string;

  @IsISO8601()
  accessTokenExpiresAt!: string;

  // Nullable: null with `X-Nile-Client: web`, which receives it in the HttpOnly cookie (spec 03 §8.1).
  @IsOptional()
  @IsString()
  refreshToken!: string | null;

  @IsISO8601()
  refreshTokenExpiresAt!: string;

  @ValidateNested()
  @Type(() => AuthUserDto)
  user!: AuthUserDto;
}

export class MessageDto {
  @IsString()
  message!: string;
}

/** `refreshToken`: the token for the body, or null when it went into the cookie. */
export function toAuthTokensDto(
  user: User,
  tokens: SessionTokens,
  refreshToken: string | null,
): AuthTokensDto {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    user: { id: user.id, email: user.email, role: user.role, status: user.status },
  };
}
