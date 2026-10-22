export const AUDIT_TABLES = {
  ADMIN_AUDIT_LOG: 'admin_audit_log',
} as const;

/** Admin paths under /api/v1 (spec 20 §2.5). */
export const AUDIT_ADMIN_PATHS = {
  LOG: '/admin/audit-log',
  ENTRY: '/admin/audit-log/:entryId',
} as const;
