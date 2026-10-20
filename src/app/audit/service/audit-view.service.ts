import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type IAccountService } from '../../identity';
import { auditEntryNotFound } from '../errors';
import { type AuditLogEntry } from '../model/audit-log-entry.model';
import { type AuditLogRepository } from '../repository/audit-log.repository';

export interface AuditEntryView {
  entry: AuditLogEntry;
  /** `null` for the CLI, or an actor identity no longer returns. */
  actorEmail: string | null;
}

/** `GET /admin/audit-log` and its detail (spec 20 §2.5). Actor emails: one batched identity call. */
@injectable()
export class AuditViewService {
  constructor(
    @inject(TOKENS.AuditLogRepository) private readonly log: AuditLogRepository,
    @inject(TOKENS.AccountService) private readonly accounts: IAccountService,
  ) {}

  async list(query: ParsedListQuery): Promise<{ items: AuditEntryView[]; meta: PageMeta }> {
    const page = toPage(await this.log.list(query), query, (entry) => entry.createdAt);
    const emails = await this.emailsOf(page.items);
    return { items: page.items.map((entry) => withEmail(entry, emails)), meta: page.meta };
  }

  async get(entryId: string): Promise<AuditEntryView> {
    const entry = await this.log.findById(entryId);
    if (!entry) throw auditEntryNotFound();
    return withEmail(entry, await this.emailsOf([entry]));
  }

  private async emailsOf(entries: readonly AuditLogEntry[]): Promise<Map<string, string>> {
    const ids = [...new Set(entries.flatMap((entry) => (entry.actorUserId ? [entry.actorUserId] : [])))];
    if (ids.length === 0) return new Map();
    const users = await this.accounts.getUsersByIds(ids);
    return new Map(users.map((user) => [user.id, user.email]));
  }
}

function withEmail(entry: AuditLogEntry, emails: ReadonlyMap<string, string>): AuditEntryView {
  return { entry, actorEmail: entry.actorUserId ? (emails.get(entry.actorUserId) ?? null) : null };
}
