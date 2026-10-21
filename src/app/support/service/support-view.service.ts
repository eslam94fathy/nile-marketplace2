import { inject, injectable } from 'tsyringe';
import { type AuthContext, UserRole } from '../../../lib/auth';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ICustomerDirectory } from '../../customers';
import { type ImageView, type MediaService } from '../../media';
import { type IOrderingDirectory } from '../../ordering';
import { type ISellerDirectory } from '../../sellers';
import { SUPPORT_DISPLAY_NAME } from '../constants';
import { SenderRole, TicketOpenerRole } from '../enums';
import { openerProfileMissing, supportTicketNotFound } from '../errors';
import { type SupportMessage } from '../model/support-message.model';
import { type SupportTicket } from '../model/support-ticket.model';
import { type SupportAttachmentRepository } from '../repository/support-attachment.repository';
import { type SupportMessageRepository } from '../repository/support-message.repository';
import { type SupportReadRepository } from '../repository/support-read.repository';
import { type SupportTicketRepository } from '../repository/support-ticket.repository';

export interface TicketView {
  ticket: SupportTicket;
  /** Of `ticket.orderId`; null without an order link. */
  orderNumber: string | null;
  hasUnread: boolean;
}

export interface MessageView {
  message: SupportMessage;
  isMe: boolean;
  displayName: string;
  attachments: ImageView[];
}

export interface Page<T> {
  items: T[];
  meta: PageMeta;
}

/**
 * Read side of spec 16 §4 for the opener: tickets and timelines, with batched lookups per page (G20):
 * order numbers (ordering), read state, attachments (media, presigned for an authorised viewer, ME-1)
 * and the opener's name (customers / sellers, SU-8).
 */
@injectable()
export class SupportViewService {
  constructor(
    @inject(TOKENS.SupportTicketRepository) private readonly tickets: SupportTicketRepository,
    @inject(TOKENS.SupportMessageRepository) private readonly messages: SupportMessageRepository,
    @inject(TOKENS.SupportAttachmentRepository) private readonly attachments: SupportAttachmentRepository,
    @inject(TOKENS.SupportReadRepository) private readonly reads: SupportReadRepository,
    @inject(TOKENS.OrderingDirectory) private readonly ordering: IOrderingDirectory,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
    @inject(TOKENS.CustomerDirectory) private readonly customers: ICustomerDirectory,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
  ) {}

  async listForOpener(opener: AuthContext, query: ParsedListQuery): Promise<Page<TicketView>> {
    const page = toPage(await this.tickets.listForOpener(opener.userId, query), query, (ticket) =>
      query.sort.field === 'createdAt' ? ticket.createdAt : ticket.lastMessageAt,
    );
    return { items: await this.ticketViews(opener.userId, page.items), meta: page.meta };
  }

  async getForOpener(opener: AuthContext, ticketId: string): Promise<TicketView> {
    const ticket = await this.tickets.findForOpener(ticketId, opener.userId);
    if (!ticket) throw supportTicketNotFound();
    const [view] = await this.ticketViews(opener.userId, [ticket]);
    if (!view) throw new Error(`no view built for ticket ${ticketId}`);
    return view;
  }

  /** The opener's timeline, without internal notes (spec 16 §4). */
  async messagesForOpener(
    opener: AuthContext,
    ticketId: string,
    query: ParsedListQuery,
  ): Promise<Page<MessageView>> {
    const ticket = await this.tickets.findForOpener(ticketId, opener.userId);
    if (!ticket) throw supportTicketNotFound();
    const page = toPage(
      await this.messages.listForTicket(ticket.id, query, false),
      query,
      (m) => m.createdAt,
    );
    return { items: await this.messageViewsForOpener(ticket, page.items), meta: page.meta };
  }

  /** Order numbers and read state for a page, one query each. */
  async ticketViews(viewerUserId: string, tickets: readonly SupportTicket[]): Promise<TicketView[]> {
    const orderIds = tickets.flatMap((t) => (t.orderId ? [t.orderId] : []));
    const [orderNumbers, lastReads] = await Promise.all([
      orderIds.length > 0 ? this.ordering.getOrderNumbers(orderIds) : new Map<string, string>(),
      this.reads.findLastReads(
        viewerUserId,
        tickets.map((t) => t.id),
      ),
    ]);
    return tickets.map((ticket) => {
      const lastRead = lastReads.get(ticket.id);
      // The opener waits for admin replies (spec 16 §1.2).
      const lastReply = ticket.lastAdminMessageAt;
      return {
        ticket,
        orderNumber: ticket.orderId ? (orderNumbers.get(ticket.orderId) ?? null) : null,
        hasUnread: lastReply !== null && (lastRead === undefined || lastReply > lastRead),
      };
    });
  }

  /** The opener sees their own name on their messages, and "Nile Support" for everything else (SU-3). */
  async messageViewsForOpener(
    ticket: SupportTicket,
    messages: readonly SupportMessage[],
  ): Promise<MessageView[]> {
    const ownMessages = messages.some((m) => m.senderUserId === ticket.openerUserId);
    const [openerName, images] = await Promise.all([
      ownMessages ? this.openerName(ticket) : Promise.resolve(''),
      this.attachmentsOf(messages),
    ]);
    return messages.map((message) => {
      const isMe = message.senderUserId === ticket.openerUserId;
      return {
        message,
        isMe,
        displayName: isMe ? openerName : SUPPORT_DISPLAY_NAME,
        attachments: images.get(message.id) ?? [],
      };
    });
  }

  /** Attachments per message: one query for the ids, one batched media read (presigned GETs). */
  private async attachmentsOf(messages: readonly SupportMessage[]): Promise<Map<string, ImageView[]>> {
    const mediaIdsByMessage = await this.attachments.findMediaIds(messages.map((m) => m.id));
    const images = await this.media.getImages([...mediaIdsByMessage.values()].flat());
    return new Map(
      [...mediaIdsByMessage].map(([messageId, mediaIds]) => [
        messageId,
        mediaIds.flatMap((id) => {
          const image = images.get(id);
          return image ? [image] : [];
        }),
      ]),
    );
  }

  /** "First Last" for a customer, the business name for a seller (SU-8). */
  private async openerName(ticket: SupportTicket): Promise<string> {
    const { openerUserId: userId } = ticket;
    if (ticket.openerRole === TicketOpenerRole.CUSTOMER) {
      const name = (await this.customers.getFullNamesByUserIds([userId])).get(userId);
      if (name === undefined) throw openerProfileMissing(UserRole.CUSTOMER, userId);
      return name;
    }
    const seller = (await this.sellers.getSummariesByUserIds([userId])).get(userId);
    if (!seller) throw openerProfileMissing(UserRole.SELLER, userId);
    return seller.businessName;
  }
}

/** The sender role a ticket's opener writes with. */
export const senderRoleOf = (role: TicketOpenerRole): SenderRole =>
  role === TicketOpenerRole.CUSTOMER ? SenderRole.CUSTOMER : SenderRole.SELLER;
