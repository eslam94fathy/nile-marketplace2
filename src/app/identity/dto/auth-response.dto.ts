import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsISO8601, IsString, IsUUID, ValidateNested } from 'class-validator';
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

  @IsString()
  refreshToken!: string;

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

export function toAuthTokensDto(user: User, tokens: SessionTokens): AuthTokensDto {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    user: { id: user.id, email: user.email, role: user.role, status: user.status },
  };
}
