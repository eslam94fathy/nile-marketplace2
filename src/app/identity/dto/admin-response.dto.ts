import { IsEmail, IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { UserRole } from '../../../lib/auth';
import { UserStatus } from '../enums';
import { type User } from '../model/user.model';

/* Response DTOs for spec 03 §4.10–§4.13 (decorators describe the OpenAPI shape only). */

export class InvitedAdminDto {
  @IsUUID()
  id!: string;

  @IsEmail()
  email!: string;

  @IsIn([UserRole.ADMIN])
  role!: UserRole;

  @IsIn([UserStatus.INVITED])
  status!: UserStatus;

  @IsISO8601()
  createdAt!: string;
}

export class AdminListItemDto {
  @IsUUID()
  id!: string;

  @IsEmail()
  email!: string;

  @IsIn(Object.values(UserStatus))
  status!: UserStatus;

  // Nullable: present in every item, null until verified / first login.
  @IsOptional()
  @IsISO8601()
  emailVerifiedAt!: string | null;

  @IsOptional()
  @IsISO8601()
  lastLoginAt!: string | null;

  @IsISO8601()
  createdAt!: string;
}

export class UserStatusDto {
  @IsUUID()
  id!: string;

  @IsEmail()
  email!: string;

  @IsIn(Object.values(UserRole))
  role!: UserRole;

  @IsIn(Object.values(UserStatus))
  status!: UserStatus;
}

export function toInvitedAdminDto(user: User): InvitedAdminDto {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toAdminListItemDto(user: User): AdminListItemDto {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toUserStatusDto(user: User): UserStatusDto {
  return { id: user.id, email: user.email, role: user.role, status: user.status };
}
