import { type TicketCategory, type TicketOpenerRole, type TicketStatus } from '../enums';

/** A row of `support_tickets` (spec 16 §1, §1.2). */
export interface SupportTicket {
  id: string;
  ticketNumber: string;
  openerUserId: string;
  openerRole: TicketOpenerRole;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  orderId: string | null;
  sellerOrderId: string | null;
  assignedAdminUserId: string | null;
  lastMessageAt: Date;
  lastUserMessageAt: Date;
  lastAdminMessageAt: Date | null;
  awaitingAdminSince: Date | null;
  slaBreachedAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
}

/** UC-SU-1: what the opener sets; the rest starts as an `open` ticket waiting since `at`. */
export interface NewSupportTicket {
  openerUserId: string;
  openerRole: TicketOpenerRole;
  category: TicketCategory;
  subject: string;
  orderId: string | null;
  sellerOrderId: string | null;
  at: Date;
}

/** What realtime shows of a ticket (spec 15 §3.1, SU-19). */
export interface TicketState {
  status: TicketStatus;
  openerUserId: string;
  assignedAdminUserId: string | null;
}

/** Back-office dashboard counts (spec 16 §2, spec 20 §3.2). `slaBreached` = waiting now with the flag set (SU-11). */
export interface SupportStats {
  open: number;
  awaitingAdmin: number;
  slaBreached: number;
}
