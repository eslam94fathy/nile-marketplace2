import { inject, injectable } from 'tsyringe';
import { type AuthContext, UserRole } from '../../../lib/auth';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type IOutbox,
  SupportMessageCreated,
  SupportTicketOpened,
  SupportTicketStatusChanged,
} from '../../../lib/events';
import { type ICustomerDirectory } from '../../customers';
import { MediaPurpose, type MediaService } from '../../media';
import { type IOrderingDirectory } from '../../ordering';
import { type ISellerDirectory } from '../../sellers';
import { SYSTEM_LINES } from '../constants';
import { MessageKind, SenderRole, TicketCategory, TicketOpenerRole, TicketStatus } from '../enums';
import {
  openerProfileMissing,
  orderLinkNotFound,
  sellerOrderLinkNotFound,
  supportCategoryNotAllowed,
  supportOpenTicketLimitReached,
  supportTicketClosed,
  supportTicketNotFound,
} from '../errors';
import { type NewSupportMessage, type SupportMessage } from '../model/support-message.model';
import { type SupportTicket } from '../model/support-ticket.model';
import { type SupportAttachmentRepository } from '../repository/support-attachment.repository';
import { type SupportMessageRepository } from '../repository/support-message.repository';
import { type SupportReadRepository } from '../repository/support-read.repository';
import { type SupportTicketRepository } from '../repository/support-ticket.repository';
import { afterUserMessage } from './ticket-transitions';
import { senderRoleOf } from './support-view.service';

export interface MessageInput {
  body: string;
  attachmentMediaIds: readonly string[];
}

export interface OpenTicketInput extends MessageInput {
  category: TicketCategory;
  subject: string;
  orderId?: string;
  sellerOrderId?: string;
}

interface OrderLinkIds {
  orderId: string | null;
  sellerOrderId: string | null;
}

/**
 * The opener's writes (spec 16 UC-SU-1, UC-SU-2 user side, UC-SU-4). Reads in other modules (profile,
 * order link) happen before the transaction; inside it the ticket is locked first, then the media
 * rows (in `claim`).
 */
@injectable()
export class SupportTicketService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'SUPPORT_MAX_OPEN_TICKETS_PER_USER'>,
    @inject(TOKENS.SupportTicketRepository) private readonly tickets: SupportTicketRepository,
    @inject(TOKENS.SupportMessageRepository) private readonly messages: SupportMessageRepository,
    @inject(TOKENS.SupportAttachmentRepository) private readonly attachments: SupportAttachmentRepository,
    @inject(TOKENS.SupportReadRepository) private readonly reads: SupportReadRepository,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
    @inject(TOKENS.OrderingDirectory) private readonly ordering: IOrderingDirectory,
    @inject(TOKENS.CustomerDirectory) private readonly customers: ICustomerDirectory,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
  ) {}

  /** UC-SU-1. */
  async open(
    opener: AuthContext,
    input: OpenTicketInput,
  ): Promise<{ ticket: SupportTicket; message: SupportMessage }> {
    const openerRole = openerRoleOf(opener);
    if (input.category === TicketCategory.SELLER_ONBOARDING && openerRole !== TicketOpenerRole.SELLER) {
      throw supportCategoryNotAllowed();
    }
    const link = await this.resolveOrderLink(opener, input);
    const at = this.clock.now();
    return this.tx.run(async (trx) => {
      // Soft check without a lock: a small overshoot under concurrent opens is accepted (SU-4).
      const unfinished = await this.tickets.countUnfinished(opener.userId, trx);
      if (unfinished >= this.env.SUPPORT_MAX_OPEN_TICKETS_PER_USER) throw supportOpenTicketLimitReached();
      const ticket = await this.tickets.insert(
        {
          openerUserId: opener.userId,
          openerRole,
          category: input.category,
          subject: input.subject,
          ...link,
          at,
        },
        trx,
      );
      const [message] = await this.messages.insertMany(
        [this.userMessage(ticket, opener.userId, input.body)],
        trx,
      );
      if (!message) throw new Error('support message insert returned no row');
      await this.attach(message, opener.userId, input.attachmentMediaIds, trx);
      await this.reads.markRead(ticket.id, opener.userId, at, trx);
      await this.outbox.add(trx, {
        contract: SupportTicketOpened,
        aggregateId: ticket.id,
        payload: {
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          openerUserId: ticket.openerUserId,
          openerRole: ticket.openerRole,
          category: ticket.category,
        },
      });
      await this.messageCreated(ticket, message, trx);
      return { ticket, message };
    });
  }

  /** UC-SU-2, user side: the opener only; anyone else gets 404. */
  async postAsOpener(
    opener: AuthContext,
    ticketId: string,
    input: MessageInput,
  ): Promise<{ ticket: SupportTicket; message: SupportMessage }> {
    const at = this.clock.now();
    return this.tx.run(async (trx) => {
      const locked = await this.tickets.lockById(ticketId, trx, opener.userId);
      if (!locked) throw supportTicketNotFound();
      if (locked.status === TicketStatus.CLOSED) throw supportTicketClosed();
      const transition = afterUserMessage(locked, at);
      const lines: NewSupportMessage[] = [this.userMessage(locked, opener.userId, input.body)];
      if (transition.reopened) lines.push(systemLine(locked.id, SYSTEM_LINES.REOPENED));
      const [message, ...systemLines] = await this.messages.insertMany(lines, trx);
      if (!message) throw new Error('support message insert returned no row');
      await this.attach(message, opener.userId, input.attachmentMediaIds, trx);
      const ticket = await this.tickets.update(locked.id, transition.patch, trx);
      await this.reads.markRead(ticket.id, opener.userId, at, trx);
      await this.messageCreated(ticket, message, trx);
      if (transition.movedTo) {
        await this.statusChanged(ticket, locked.status, senderRoleOf(ticket.openerRole), trx);
      }
      for (const line of systemLines) await this.messageCreated(ticket, line, trx);
      return { ticket, message };
    });
  }

  /** UC-SU-4 for the opener. */
  async markReadAsOpener(opener: AuthContext, ticketId: string): Promise<void> {
    if (!(await this.tickets.exists(ticketId, opener.userId))) throw supportTicketNotFound();
    await this.reads.markRead(ticketId, opener.userId, this.clock.now());
  }

  /**
   * A customer may link an order and one of its seller orders; a seller one of its seller orders, whose
   * order is stored too (SU-10). Missing and foreign are one answer (conventions §3).
   */
  private async resolveOrderLink(opener: AuthContext, input: OpenTicketInput): Promise<OrderLinkIds> {
    if (opener.role === UserRole.CUSTOMER) {
      if (input.orderId === undefined) return { orderId: null, sellerOrderId: null };
      const customerId = await this.customers.getCustomerIdByUserId(opener.userId);
      if (customerId === null) throw openerProfileMissing(UserRole.CUSTOMER, opener.userId);
      if (!(await this.ordering.getCustomerOrderLink(customerId, input.orderId))) throw orderLinkNotFound();
      if (input.sellerOrderId === undefined) return { orderId: input.orderId, sellerOrderId: null };
      const link = await this.ordering.getCustomerOrderLink(customerId, input.orderId, input.sellerOrderId);
      if (!link) throw sellerOrderLinkNotFound();
      return { orderId: link.orderId, sellerOrderId: link.sellerOrderId };
    }
    if (input.sellerOrderId === undefined) return { orderId: null, sellerOrderId: null };
    // Any seller status may use support (SU-9): only the profile id is resolved.
    const seller = await this.sellers.getSellerByUserId(opener.userId);
    if (!seller) throw openerProfileMissing(UserRole.SELLER, opener.userId);
    const link = await this.ordering.getSellerOrderLink(seller.sellerId, input.sellerOrderId);
    if (!link) throw sellerOrderLinkNotFound();
    return { orderId: link.orderId, sellerOrderId: link.sellerOrderId };
  }

  private userMessage(ticket: SupportTicket, userId: string, body: string): NewSupportMessage {
    return {
      ticketId: ticket.id,
      kind: MessageKind.MESSAGE,
      senderUserId: userId,
      senderRole: senderRoleOf(ticket.openerRole),
      body,
    };
  }

  /** Claims the private images (ticket already locked: lock order ticket → media) and records them. */
  private async attach(
    message: SupportMessage,
    ownerUserId: string,
    mediaIds: readonly string[],
    trx: DbTransaction,
  ): Promise<void> {
    await this.media.claim(mediaIds, { purpose: MediaPurpose.SUPPORT_ATTACHMENT, ownerUserId }, trx);
    await this.attachments.insertMany(message.id, mediaIds, trx);
  }

  private messageCreated(ticket: SupportTicket, message: SupportMessage, trx: DbTransaction): Promise<void> {
    return this.outbox.add(trx, {
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
    });
  }

  private statusChanged(
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
}

/** The routes allow customers and sellers only. */
function openerRoleOf(opener: AuthContext): TicketOpenerRole {
  return opener.role === UserRole.SELLER ? TicketOpenerRole.SELLER : TicketOpenerRole.CUSTOMER;
}

export function systemLine(ticketId: string, body: string): NewSupportMessage {
  return { ticketId, kind: MessageKind.SYSTEM, senderUserId: null, senderRole: SenderRole.SYSTEM, body };
}
