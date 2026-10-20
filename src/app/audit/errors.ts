import { AppError } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** audit error codes (docs/spec/20-backoffice.md §6). */
export const AuditErrorCode = {
  AUDIT_ENTRY_NOT_FOUND: 'AUDIT_ENTRY_NOT_FOUND',
} as const;

export const auditEntryNotFound = () =>
  new AppError(AuditErrorCode.AUDIT_ENTRY_NOT_FOUND, 'Audit entry not found', HTTP_STATUS.NOT_FOUND);
