import { TicketStatus } from '../enums';
import { type SupportTicket } from '../model/support-ticket.model';

/** The `support_tickets` columns a message or an admin action changes (spec 16 §1.1, §1.2). */
export interface TicketPatch {
  status?: TicketStatus;
  assignedAdminUserId?: string | null;
  lastMessageAt?: Date;
  lastUserMessageAt?: Date;
  lastAdminMessageAt?: Date;
  awaitingAdminSince?: Date | null;
  slaBreachedAt?: Date | null;
  resolvedAt?: Date | null;
  closedAt?: Date | null;
}

export interface Transition {
  patch: TicketPatch;
  /** The new status when it moved, else null. */
  movedTo: TicketStatus | null;
  /** A `resolved` ticket taken up again by a message (SU-12): the timeline gets a system line. */
  reopened: boolean;
}

/**
 * A public message of the opener (UC-SU-2). `open` stays `open`, `awaiting_admin` keeps its wait;
 * from `awaiting_user` or `resolved` a new wait starts, which clears the SLA flag of the last one
 * (SU-11) and, on a reopen, `resolved_at` (SU-12). The caller has refused `closed`.
 */
export function afterUserMessage(ticket: SupportTicket, at: Date): Transition {
  const patch: TicketPatch = { lastMessageAt: at, lastUserMessageAt: at };
  if (ticket.status === TicketStatus.OPEN || ticket.status === TicketStatus.AWAITING_ADMIN) {
    return { patch, movedTo: null, reopened: false };
  }
  return {
    patch: {
      ...patch,
      status: TicketStatus.AWAITING_ADMIN,
      awaitingAdminSince: at,
      slaBreachedAt: null,
      resolvedAt: null,
    },
    movedTo: TicketStatus.AWAITING_ADMIN,
    reopened: ticket.status === TicketStatus.RESOLVED,
  };
}

/**
 * A public admin message (UC-SU-2): the ticket waits for the user. The wait for an admin ends
 * (`awaiting_admin_since` cleared; the SLA flag stays as the history of that wait, SU-11), and a
 * `resolved` ticket is reopened. The caller has refused `closed`.
 */
export function afterAdminMessage(ticket: SupportTicket, at: Date): Transition {
  const patch: TicketPatch = { lastMessageAt: at, lastAdminMessageAt: at };
  if (ticket.status === TicketStatus.AWAITING_USER) return { patch, movedTo: null, reopened: false };
  return {
    patch: { ...patch, status: TicketStatus.AWAITING_USER, awaitingAdminSince: null, resolvedAt: null },
    movedTo: TicketStatus.AWAITING_USER,
    reopened: ticket.status === TicketStatus.RESOLVED,
  };
}
