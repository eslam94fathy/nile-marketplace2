/** `admin_audit_log.actor_type` (spec 20 §2.1, CHECK `chk_admin_audit_log_actor_type`). */
export const AuditActorType = {
  ADMIN: 'admin',
  CLI: 'cli',
} as const;
export type AuditActorType = (typeof AuditActorType)[keyof typeof AuditActorType];
