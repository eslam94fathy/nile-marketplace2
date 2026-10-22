import { defineEvent } from './define-event';
import { type TicketCategoryValue } from './shared-types';

/** Publisher: support (UC-SU-1). Consumer: realtime (the `admins` room, spec 13 NO-9). */
export interface SupportTicketOpenedPayload {
  ticketId: string;
  ticketNumber: string;
  openerUserId: string;
  openerRole: 'customer' | 'seller';
  category: TicketCategoryValue;
}

export const SupportTicketOpened = defineEvent<SupportTicketOpenedPayload>(
  'support.ticket_opened',
  1,
  'support_ticket',
);
