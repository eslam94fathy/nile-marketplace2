import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { AUDIT_ACTION_NAMES, type AuditAction, AuditTargetType, type AuditValues } from '../../../lib/audit';
import { AuditActorType } from '../enums';
import { type AuditEntryView } from '../service/audit-view.service';

/* Response DTOs for spec 20 §2.5 (decorators describe the OpenAPI shape only). */

export class AuditActorDto {
  @IsUUID()
  userId!: string;

  // Nullable: null if identity no longer returns the user.
  @IsOptional()
  @IsEmail()
  email!: string | null;
}

export class AuditChangesDto {
  /** The allow-listed fields before the change (`{}` for a create). */
  @IsObject()
  before!: AuditValues;

  /** The allow-listed fields after the change (`{}` for a delete). */
  @IsObject()
  after!: AuditValues;
}

export class AuditEntryDto {
  @IsUUID()
  id!: string;

  @IsIn(Object.values(AuditActorType))
  actorType!: AuditActorType;

  // Nullable: null for the CLI.
  @IsOptional()
  @ValidateNested()
  @Type(() => AuditActorDto)
  actor!: AuditActorDto | null;

  @IsIn(AUDIT_ACTION_NAMES)
  action!: AuditAction;

  @IsIn(Object.values(AuditTargetType))
  targetType!: AuditTargetType;

  // Nullable: null for settings.
  @IsOptional()
  @IsUUID()
  targetId!: string | null;

  // Nullable: null when no recorded field changed.
  @IsOptional()
  @ValidateNested()
  @Type(() => AuditChangesDto)
  changes!: AuditChangesDto | null;

  @IsOptional()
  @IsString()
  reason!: string | null;

  @IsOptional()
  @IsUUID()
  correlationId!: string | null;

  @IsOptional()
  @IsString()
  ip!: string | null;

  @IsISO8601()
  createdAt!: string;
}

export function toAuditEntryDto({ entry, actorEmail }: AuditEntryView): AuditEntryDto {
  return {
    id: entry.id,
    actorType: entry.actorType,
    actor: entry.actorUserId ? { userId: entry.actorUserId, email: actorEmail } : null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    changes: entry.changes,
    reason: entry.reason,
    correlationId: entry.correlationId,
    ip: entry.ip,
    createdAt: entry.createdAt.toISOString(),
  };
}
