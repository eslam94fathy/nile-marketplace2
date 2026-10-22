import { type AuditAction, type AuditTargetType, type AuditValues } from '../../../lib/audit';
import { type AuditActorType } from '../enums';

export interface AuditChanges {
  before: AuditValues;
  after: AuditValues;
}

/** One row of `admin_audit_log` (append-only, spec 20 §2.1). */
export interface AuditLogEntry {
  id: string;
  actorType: AuditActorType;
  /** `null` only for the CLI. */
  actorUserId: string | null;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string | null;
  changes: AuditChanges | null;
  reason: string | null;
  correlationId: string | null;
  ip: string | null;
  createdAt: Date;
}

export type NewAuditLogEntry = Omit<AuditLogEntry, 'id' | 'createdAt'>;
