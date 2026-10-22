import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type IOutbox,
  SupportMessageCreated,
  SupportTicketAssigned,
  SupportTicketStatusChanged,
} from '../../../lib/events';
import { MessageKind, SenderRole, type TicketStatus } from '../enums';
import { type NewSupportMessage, type SupportMessage } from '../model/support-message.model';
import { type SupportTicket } from '../model/support-ticket.model';
import { type SupportMessageRepository } from '../repository/support-message.repository';

export function systemLine(ticketId: string, body: string): NewSupportMessage {
  return { ticketId, kind: MessageKind.SYSTEM, senderUserId: null, senderRole: SenderRole.SYSTEM, body };
}

/**
 * The write steps every support action shares, inside the caller's transaction (ticket already
 * locked): messages and system lines, and the outbox events (spec 16 §5). Used by the api and by the
 * worker's jobs, so it needs no media (attachments: `SupportAttachmentService`).
 */
@injectable()
export class SupportTimelineService {
  constructor(
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.SupportMessageRepository) private readonly messages: SupportMessageRepository,
  ) {}

  /** One multi-row insert; the rows come back in the given order. */
  async append(lines: readonly NewSupportMessage[], trx: DbTransaction): Promise<SupportMessage[]> {
    const inserted = await this.messages.insertMany(lines, trx);
    if (inserted.length !== lines.length) throw new Error('support message insert lost rows');
    return inserted;
  }

  /** One `support.message_created` per message, after the ticket's update (current assignee). */
  async messagesCreated(
    ticket: SupportTicket,
    messages: readonly SupportMessage[],
    trx: DbTransaction,
  ): Promise<void> {
    await this.outbox.addMany(
      trx,
      messages.map((message) => ({
        contract: SupportMessageCreated,
        aggregateId: ticket.id,
        payload: {
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          messageId: message.id,
          kind: message.kind,
          senderRole: message.senderRole,
          openerUserId: ticket.openerUserId,
          assignedAdminUserId: ticket.assignedAdminUserId,
        },
      })),
    );
  }

  statusChanged(
    ticket: SupportTicket,
    from: TicketStatus,
    actor: SenderRole,
    trx: DbTransaction,
  ): Promise<void> {
    return this.outbox.add(trx, {
      contract: SupportTicketStatusChanged,
      aggregateId: ticket.id,
      payload: {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        openerUserId: ticket.openerUserId,
        from,
        to: ticket.status,
        actor,
      },
    });
  }

  assigned(ticket: SupportTicket, previousAdminUserId: string | null, trx: DbTransaction): Promise<void> {
    return this.outbox.add(trx, {
      contract: SupportTicketAssigned,
      aggregateId: ticket.id,
      payload: {
        ticketId: ticket.id,
        openerUserId: ticket.openerUserId,
        assignedAdminUserId: ticket.assignedAdminUserId,
        previousAdminUserId,
      },
    });
  }
}
