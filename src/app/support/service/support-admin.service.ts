import { inject, injectable } from 'tsyringe';
import { type IAuditRecorder } from '../../../lib/audit';
import { type AuthContext, UserRole } from '../../../lib/auth';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IAccountService, UserStatus } from '../../identity';
import { SYSTEM_LINES } from '../constants';
import { MessageKind, SenderRole, TicketStatus, UNFINISHED_STATUSES } from '../enums';
import {
  supportAssigneeInvalid,
  supportTicketClosed,
  supportTicketInvalidStatusTransition,
  supportTicketNotFound,
} from '../errors';
import { type NewSupportMessage, type SupportMessage } from '../model/support-message.model';
import { type SupportTicket } from '../model/support-ticket.model';
import { type SupportReadRepository } from '../repository/support-read.repository';
import { type SupportTicketRepository } from '../repository/support-ticket.repository';
import { type MessageInput } from './support-ticket.service';
import { type SupportAttachmentService } from './support-attachment.service';
import { type SupportTimelineService, systemLine } from './support-timeline.service';
import { afterAdminMessage, type TicketPatch } from './ticket-transitions';

export interface AdminMessageInput extends MessageInput {
  /** An internal note: never shown to the user, no status or bookkeeping change. */
  internal: boolean;
}

/**
 * Admin writes (spec 16 UC-SU-2 admin side, UC-SU-3, UC-SU-4). Each locks the ticket first. Assign,
 * resolve and close are audited (SU-5), and so is the auto-assign of a first reply (SU-18); messages
 * and notes are not (the message table is the record).
 */
@injectable()
export class SupportAdminService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
    @inject(TOKENS.AccountService) private readonly accounts: IAccountService,
    @inject(TOKENS.SupportTicketRepository) private readonly tickets: SupportTicketRepository,
    @inject(TOKENS.SupportReadRepository) private readonly reads: SupportReadRepository,
    @inject(TOKENS.SupportTimelineService) private readonly timeline: SupportTimelineService,
    @inject(TOKENS.SupportAttachmentService) private readonly attachments: SupportAttachmentService,
  ) {}

  /**
   * UC-SU-2, admin side. A note is allowed on any status, `closed` included. A public message on a
   * `closed` ticket is 409; on an unassigned ticket it assigns the sender (SU-2).
   */
  async post(
    admin: AuthContext,
    ticketId: string,
    input: AdminMessageInput,
  ): Promise<{ ticket: SupportTicket; message: SupportMessage }> {
    const at = this.clock.now();
    return this.tx.run(async (trx) => {
      const locked = await this.lock(ticketId, trx);
      const own: NewSupportMessage = {
        ticketId: locked.id,
        kind: input.internal ? MessageKind.INTERNAL_NOTE : MessageKind.MESSAGE,
        senderUserId: admin.userId,
        senderRole: SenderRole.ADMIN,
        body: input.body,
      };
      if (input.internal) {
        const [note] = await this.timeline.append([own], trx);
        if (!note) throw new Error('support message insert returned no row');
        await this.attachments.attach(note, admin.userId, input.attachmentMediaIds, trx);
        await this.reads.markRead(locked.id, admin.userId, at, trx);
        await this.timeline.messagesCreated(locked, [note], trx);
        return { ticket: locked, message: note };
      }

      if (locked.status === TicketStatus.CLOSED) throw supportTicketClosed();
      const transition = afterAdminMessage(locked, at);
      const autoAssign = locked.assignedAdminUserId === null;
      const lines = [own];
      if (transition.reopened) lines.push(systemLine(locked.id, SYSTEM_LINES.REOPENED));
      if (autoAssign) lines.push(systemLine(locked.id, SYSTEM_LINES.ASSIGNED));
      const created = await this.timeline.append(lines, trx);
      const [message] = created;
      if (!message) throw new Error('support message insert returned no row');
      await this.attachments.attach(message, admin.userId, input.attachmentMediaIds, trx);
      const patch: TicketPatch = autoAssign
        ? { ...transition.patch, assignedAdminUserId: admin.userId }
        : transition.patch;
      const ticket = await this.tickets.update(locked.id, patch, trx);
      await this.reads.markRead(ticket.id, admin.userId, at, trx);
      await this.timeline.messagesCreated(ticket, created, trx);
      if (transition.movedTo) await this.timeline.statusChanged(ticket, locked.status, SenderRole.ADMIN, trx);
      if (autoAssign) await this.recordAssignment(ticket, null, trx);
      return { ticket, message };
    });
  }

  /**
   * UC-SU-3 assign: an active admin, or `null` to unassign. The actor (audit) comes from the request. The current assignee again writes nothing
   * (SU-13); a `closed` ticket is 409.
   */
  async assign(ticketId: string, adminUserId: string | null): Promise<SupportTicket> {
    if (adminUserId !== null) await this.checkAssignee(adminUserId);
    const at = this.clock.now();
    return this.tx.run(async (trx) => {
      const locked = await this.lock(ticketId, trx);
      if (locked.status === TicketStatus.CLOSED) throw supportTicketClosed();
      if (locked.assignedAdminUserId === adminUserId) return locked;
      const line = systemLine(locked.id, adminUserId ? SYSTEM_LINES.ASSIGNED : SYSTEM_LINES.UNASSIGNED);
      const created = await this.timeline.append([line], trx);
      const ticket = await this.tickets.update(
        locked.id,
        { assignedAdminUserId: adminUserId, lastMessageAt: at },
        trx,
      );
      await this.timeline.messagesCreated(ticket, created, trx);
      await this.recordAssignment(ticket, locked.assignedAdminUserId, trx);
      return ticket;
    });
  }

  /** UC-SU-3 resolve: from open / awaiting_* only; the wait for an admin ends (SU-12). */
  resolve(ticketId: string): Promise<SupportTicket> {
    return this.changeStatus(ticketId, {
      allowedFrom: UNFINISHED_STATUSES,
      to: TicketStatus.RESOLVED,
      line: SYSTEM_LINES.RESOLVED,
      action: 'support_ticket.resolved',
      patch: (at) => ({ resolvedAt: at }),
    });
  }

  /** UC-SU-3 close: from any status but `closed`; `resolved_at` is kept (SU-12). */
  close(ticketId: string): Promise<SupportTicket> {
    return this.changeStatus(ticketId, {
      allowedFrom: [...UNFINISHED_STATUSES, TicketStatus.RESOLVED],
      to: TicketStatus.CLOSED,
      line: SYSTEM_LINES.CLOSED,
      action: 'support_ticket.closed',
      patch: (at) => ({ closedAt: at }),
    });
  }

  /** UC-SU-4 for any admin. */
  async markRead(admin: AuthContext, ticketId: string): Promise<void> {
    if (!(await this.tickets.exists(ticketId))) throw supportTicketNotFound();
    await this.reads.markRead(ticketId, admin.userId, this.clock.now());
  }

  private async changeStatus(
    ticketId: string,
    change: {
      allowedFrom: readonly TicketStatus[];
      to: TicketStatus;
      line: string;
      action: 'support_ticket.resolved' | 'support_ticket.closed';
      patch: (at: Date) => TicketPatch;
    },
  ): Promise<SupportTicket> {
    const at = this.clock.now();
    return this.tx.run(async (trx) => {
      const locked = await this.lock(ticketId, trx);
      if (!change.allowedFrom.includes(locked.status)) throw supportTicketInvalidStatusTransition();
      const created = await this.timeline.append([systemLine(locked.id, change.line)], trx);
      const ticket = await this.tickets.update(
        locked.id,
        { status: change.to, awaitingAdminSince: null, lastMessageAt: at, ...change.patch(at) },
        trx,
      );
      await this.timeline.messagesCreated(ticket, created, trx);
      await this.timeline.statusChanged(ticket, locked.status, SenderRole.ADMIN, trx);
      await this.audit.record(
        {
          action: change.action,
          targetId: ticket.id,
          before: { status: locked.status },
          after: { status: ticket.status },
        },
        trx,
      );
      return ticket;
    });
  }

  private async lock(ticketId: string, trx: DbTransaction): Promise<SupportTicket> {
    const ticket = await this.tickets.lockById(ticketId, trx);
    if (!ticket) throw supportTicketNotFound();
    return ticket;
  }

  private async recordAssignment(
    ticket: SupportTicket,
    previousAdminUserId: string | null,
    trx: DbTransaction,
  ): Promise<void> {
    await this.timeline.assigned(ticket, previousAdminUserId, trx);
    await this.audit.record(
      {
        action: 'support_ticket.assigned',
        targetId: ticket.id,
        before: { assignedAdminUserId: previousAdminUserId },
        after: { assignedAdminUserId: ticket.assignedAdminUserId },
      },
      trx,
    );
  }

  /** An active admin account (identity); anything else, unknown included, is 422. */
  private async checkAssignee(userId: string): Promise<void> {
    const [user] = await this.accounts.getUsersByIds([userId]);
    if (user?.role !== UserRole.ADMIN || user.status !== UserStatus.ACTIVE) throw supportAssigneeInvalid();
  }
}
