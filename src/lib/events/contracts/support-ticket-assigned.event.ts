import { defineEvent } from './define-event';

/** Publisher: support (UC-SU-2 auto-assign, UC-SU-3 assign). Consumer: realtime. */
export interface SupportTicketAssignedPayload {
  ticketId: string;
  openerUserId: string;
  assignedAdminUserId: string | null;
  previousAdminUserId: string | null;
}

export const SupportTicketAssigned = defineEvent<SupportTicketAssignedPayload>(
  'support.ticket_assigned',
  1,
  'support_ticket',
);
