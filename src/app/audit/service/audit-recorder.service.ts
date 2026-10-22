import { inject, injectable } from 'tsyringe';
import {
  type AuditEntry,
  auditFieldsOf,
  auditTargetOf,
  type AuditValues,
  type IAuditRecorder,
} from '../../../lib/audit';
import { getContext } from '../../../lib/context';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { AuditActorType } from '../enums';
import { type AuditChanges } from '../model/audit-log-entry.model';
import { type AuditLogRepository } from '../repository/audit-log.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Writes one audit row in the caller's transaction (spec 20 §2.2). Fields outside the action's
 * allow-list are dropped with a warning (name only, never the value); an update keeps only the
 * fields that changed. One insert, no other reads.
 */
@injectable()
export class AuditRecorderService implements IAuditRecorder {
  constructor(
    @inject(TOKENS.AuditLogRepository) private readonly log: AuditLogRepository,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async record(entry: AuditEntry, trx: DbTransaction): Promise<void> {
    const context = getContext();
    const actorUserId = context?.cli ? null : context?.userId;
    // A programming error, not a client error: an admin write always runs after `authenticate`.
    if (actorUserId === undefined) throw new Error(`audit entry ${entry.action} has no actor`);

    const correlationId = context?.correlationId;
    await this.log.insert(
      {
        actorType: actorUserId === null ? AuditActorType.CLI : AuditActorType.ADMIN,
        actorUserId,
        action: entry.action,
        targetType: auditTargetOf(entry.action),
        targetId: entry.targetId,
        changes: this.changesOf(entry),
        reason: entry.reason ?? null,
        correlationId: correlationId && UUID_PATTERN.test(correlationId) ? correlationId : null,
        ip: context?.ip ?? null,
      },
      trx,
    );
  }

  private changesOf(entry: AuditEntry): AuditChanges | null {
    const allowed = new Set(auditFieldsOf(entry.action));
    const before = this.allowedOnly(entry, entry.before, allowed);
    const after = this.allowedOnly(entry, entry.after, allowed);
    if (before && after) {
      // An update: keep the fields whose value changed.
      const changed = new Set(
        [...Object.keys(before), ...Object.keys(after)].filter((key) => before[key] !== after[key]),
      );
      if (changed.size === 0) return null;
      return { before: pick(before, changed), after: pick(after, changed) };
    }
    if (!before && !after) return null;
    return { before: before ?? {}, after: after ?? {} };
  }

  private allowedOnly(
    entry: AuditEntry,
    values: AuditValues | undefined,
    allowed: ReadonlySet<string>,
  ): Record<string, AuditValues[string]> | undefined {
    if (!values) return undefined;
    const kept: Record<string, AuditValues[string]> = {};
    for (const [key, value] of Object.entries(values)) {
      if (allowed.has(key)) kept[key] = value;
      else
        this.logger.warn('audit field dropped', {
          event: 'AUDIT_FIELD_DROPPED',
          action: entry.action,
          field: key,
        });
    }
    return kept;
  }
}

function pick(values: AuditValues, keys: ReadonlySet<string>): AuditValues {
  return Object.fromEntries(Object.entries(values).filter(([key]) => keys.has(key)));
}
