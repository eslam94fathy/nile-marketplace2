import { defineEvent } from './define-event';
import { type TicketMessageKindValue, type TicketSenderRoleValue } from './shared-types';

/**
 * Publisher: support (UC-SU-1, UC-SU-2, status lines). Consumers: realtime, notifications (a public
 * admin message → the opener, a user message → the assigned admin). Internal notes reach admins only.
 */
export interface SupportMessageCreatedPayload {
  ticketId: string;
  ticketNumber: string;
  messageId: string;
  kind: TicketMessageKindValue;
  senderRole: TicketSenderRoleValue;
  openerUserId: string;
  assignedAdminUserId: string | null;
}

export const SupportMessageCreated = defineEvent<SupportMessageCreatedPayload>(
  'support.message_created',
  1,
  'support_ticket',
);
