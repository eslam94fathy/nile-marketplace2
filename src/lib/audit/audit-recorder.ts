import { type DbTransaction } from '../db';
import { type AuditAction } from './audit-actions';

/** Money and rates are passed as strings (CLAUDE.md §6.2). */
export type AuditValue = string | number | boolean | null;
export type AuditValues = Readonly<Record<string, AuditValue>>;

/**
 * One admin write (docs/spec/20-backoffice.md §2.2). The target type follows from the action.
 * A create passes only `after`, a delete only `before`, an update both (only changed fields are kept).
 */
export interface AuditEntry {
  action: AuditAction;
  /** `null` for settings: the action names the setting. */
  targetId: string | null;
  before?: AuditValues;
  after?: AuditValues;
  reason?: string | null;
}

/**
 * Writes the audit row in the caller's transaction, so it commits or rolls back with the change
 * (spec 20 §2.2). The actor, IP and correlation id come from the request context, never from the
 * caller. Implemented by the audit module, injected with `TOKENS.AuditRecorder`.
 */
export interface IAuditRecorder {
  record(entry: AuditEntry, trx: DbTransaction): Promise<void>;
}
