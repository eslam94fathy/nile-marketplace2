import { inject, injectable } from 'tsyringe';
import { type AuthContext, UserRole } from '../../../lib/auth';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ICustomerDirectory } from '../../customers';
import { type IAccountService } from '../../identity';
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
import {
  type AdminTicketFilters,
  type SupportTicketRepository,
} from '../repository/support-ticket.repository';

export interface TicketView {
  ticket: SupportTicket;
  /** Of `ticket.orderId`; null without an order link. */
  orderNumber: string | null;
  hasUnread: boolean;
}

export interface AdminTicketView extends TicketView {
  opener: { userId: string; role: TicketOpenerRole; displayName: string; email: string };
  /** Admins are shown by email (SU-7). */
  assignedAdmin: { userId: string; displayName: string } | null;
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

/** Whose read state decides `hasUnread`: the opener waits for admin replies, admins for user messages. */
const Side = { OPENER: 'opener', ADMIN: 'admin' } as const;
type Side = (typeof Side)[keyof typeof Side];

/**
 * Read side of spec 16 §4, with batched lookups per page (G20): order numbers (ordering), read state,
 * attachments (media, presigned for an authorised viewer, ME-1), names (customers / sellers, SU-8) and
 * emails (identity, SU-7).
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
    @inject(TOKENS.AccountService) private readonly accounts: IAccountService,
  ) {}

  // ---- opener (spec 16 §4.1) ----

  async listForOpener(opener: AuthContext, query: ParsedListQuery): Promise<Page<TicketView>> {
    const page = toPage(await this.tickets.listForOpener(opener.userId, query), query, sortValueOf(query));
    return { items: await this.ticketViews(opener.userId, page.items), meta: page.meta };
  }

  async getForOpener(opener: AuthContext, ticketId: string): Promise<TicketView> {
    const ticket = await this.tickets.findForOpener(ticketId, opener.userId);
    if (!ticket) throw supportTicketNotFound();
    return single(await this.ticketViews(opener.userId, [ticket]));
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

  ticketViews(viewerUserId: string, tickets: readonly SupportTicket[]): Promise<TicketView[]> {
    return this.baseViews(viewerUserId, tickets, Side.OPENER);
  }

  /** The opener sees their own name on their messages, and "Nile Support" for everything else (SU-3). */
  async messageViewsForOpener(
    ticket: SupportTicket,
    messages: readonly SupportMessage[],
  ): Promise<MessageView[]> {
    const ownMessages = messages.some((m) => m.senderUserId === ticket.openerUserId);
    const [names, images] = await Promise.all([
      ownMessages ? this.openerNames([ticket]) : new Map<string, string>(),
      this.attachmentsOf(messages),
    ]);
    return messages.map((message) => {
      const isMe = message.senderUserId === ticket.openerUserId;
      return {
        message,
        isMe,
        displayName: isMe ? nameOf(names, ticket) : SUPPORT_DISPLAY_NAME,
        attachments: images.get(message.id) ?? [],
      };
    });
  }

  // ---- admin (spec 16 §4.2) ----

  async listForAdmin(
    admin: AuthContext,
    query: ParsedListQuery,
    filters: AdminTicketFilters,
  ): Promise<Page<AdminTicketView>> {
    const page = toPage(await this.tickets.listForAdmin(query, filters), query, sortValueOf(query));
    return { items: await this.adminTicketViews(admin.userId, page.items), meta: page.meta };
  }

  async getForAdmin(admin: AuthContext, ticketId: string): Promise<AdminTicketView> {
    const ticket = await this.tickets.findById(ticketId);
    if (!ticket) throw supportTicketNotFound();
    return single(await this.adminTicketViews(admin.userId, [ticket]));
  }

  /** The whole timeline, internal notes included. */
  async messagesForAdmin(
    admin: AuthContext,
    ticketId: string,
    query: ParsedListQuery,
  ): Promise<Page<MessageView>> {
    const ticket = await this.tickets.findById(ticketId);
    if (!ticket) throw supportTicketNotFound();
    const page = toPage(await this.messages.listForTicket(ticket.id, query, true), query, (m) => m.createdAt);
    return { items: await this.messageViewsForAdmin(admin.userId, ticket, page.items), meta: page.meta };
  }

  async adminTicketViews(adminUserId: string, tickets: readonly SupportTicket[]): Promise<AdminTicketView[]> {
    const assignees = tickets.flatMap((t) => (t.assignedAdminUserId ? [t.assignedAdminUserId] : []));
    const [base, names, emails] = await Promise.all([
      this.baseViews(adminUserId, tickets, Side.ADMIN),
      this.openerNames(tickets),
      this.emails([...tickets.map((t) => t.openerUserId), ...assignees]),
    ]);
    return base.map((view) => {
      const { ticket } = view;
      const assignee = ticket.assignedAdminUserId;
      return {
        ...view,
        opener: {
          userId: ticket.openerUserId,
          role: ticket.openerRole,
          displayName: nameOf(names, ticket),
          email: emailOf(emails, ticket.openerUserId),
        },
        assignedAdmin: assignee ? { userId: assignee, displayName: emailOf(emails, assignee) } : null,
      };
    });
  }

  /** Admins see the opener's name, every admin by email (SU-7), and the server as "Nile Support". */
  async messageViewsForAdmin(
    adminUserId: string,
    ticket: SupportTicket,
    messages: readonly SupportMessage[],
  ): Promise<MessageView[]> {
    const adminIds = messages.flatMap((m) =>
      m.senderRole === SenderRole.ADMIN && m.senderUserId ? [m.senderUserId] : [],
    );
    const fromOpener = messages.some((m) => m.senderUserId === ticket.openerUserId);
    const [names, emails, images] = await Promise.all([
      fromOpener ? this.openerNames([ticket]) : new Map<string, string>(),
      this.emails(adminIds),
      this.attachmentsOf(messages),
    ]);
    return messages.map((message) => {
      const sender = message.senderUserId;
      let displayName = SUPPORT_DISPLAY_NAME;
      if (sender === ticket.openerUserId) displayName = nameOf(names, ticket);
      else if (sender !== null) displayName = emailOf(emails, sender);
      return {
        message,
        isMe: sender === adminUserId,
        displayName,
        attachments: images.get(message.id) ?? [],
      };
    });
  }

  // ---- shared ----

  /** Order numbers and the viewer's read state for a page, one query each. */
  private async baseViews(
    viewerUserId: string,
    tickets: readonly SupportTicket[],
    side: Side,
  ): Promise<TicketView[]> {
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
      // Spec 16 §1.2: the other side's latest public message against the viewer's last read.
      const lastFromOtherSide = side === Side.OPENER ? ticket.lastAdminMessageAt : ticket.lastUserMessageAt;
      return {
        ticket,
        orderNumber: ticket.orderId ? (orderNumbers.get(ticket.orderId) ?? null) : null,
        hasUnread: lastFromOtherSide !== null && (lastRead === undefined || lastFromOtherSide > lastRead),
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

  /** Opener user id → "First Last" (customers) or the business name (sellers) (SU-8): one call per role. */
  private async openerNames(tickets: readonly SupportTicket[]): Promise<Map<string, string>> {
    const idsOf = (role: TicketOpenerRole) => [
      ...new Set(tickets.filter((t) => t.openerRole === role).map((t) => t.openerUserId)),
    ];
    const customerIds = idsOf(TicketOpenerRole.CUSTOMER);
    const sellerIds = idsOf(TicketOpenerRole.SELLER);
    const [customers, sellers] = await Promise.all([
      customerIds.length > 0 ? this.customers.getFullNamesByUserIds(customerIds) : new Map<string, string>(),
      sellerIds.length > 0
        ? this.sellers.getSummariesByUserIds(sellerIds)
        : new Map<string, { businessName: string }>(),
    ]);
    return new Map([
      ...customers,
      ...[...sellers].map(([userId, seller]) => [userId, seller.businessName] as const),
    ]);
  }

  private async emails(userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const users = await this.accounts.getUsersByIds([...new Set(userIds)]);
    return new Map(users.map((user) => [user.id, user.email]));
  }
}

/** The sender role a ticket's opener writes with. */
export const senderRoleOf = (role: TicketOpenerRole): SenderRole =>
  role === TicketOpenerRole.CUSTOMER ? SenderRole.CUSTOMER : SenderRole.SELLER;

function sortValueOf(query: ParsedListQuery): (ticket: SupportTicket) => Date {
  return (ticket) => {
    if (query.sort.field === 'createdAt') return ticket.createdAt;
    if (query.sort.field === 'awaitingAdminSince' && ticket.awaitingAdminSince)
      return ticket.awaitingAdminSince;
    return ticket.lastMessageAt;
  };
}

/** A missing opener profile is a data defect: 500 (SU-9, as P4-Q9). */
function nameOf(names: ReadonlyMap<string, string>, ticket: SupportTicket): string {
  const name = names.get(ticket.openerUserId);
  if (name === undefined) {
    const role = ticket.openerRole === TicketOpenerRole.CUSTOMER ? UserRole.CUSTOMER : UserRole.SELLER;
    throw openerProfileMissing(role, ticket.openerUserId);
  }
  return name;
}

/** Users are never deleted, so every opener and admin has an email. */
function emailOf(emails: ReadonlyMap<string, string>, userId: string): string {
  const email = emails.get(userId);
  if (email === undefined) throw new Error(`user ${userId} of a support ticket is missing`);
  return email;
}

function single<T>(views: readonly T[]): T {
  const [view] = views;
  if (view === undefined) throw new Error('no view built for the ticket');
  return view;
}
