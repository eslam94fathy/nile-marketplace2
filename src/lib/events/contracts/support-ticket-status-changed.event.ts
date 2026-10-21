import { defineEvent } from './define-event';
import { type TicketStatusValue } from './shared-types';

/** Publisher: support (messages, resolve, close, auto-close). Consumers: realtime, notifications (→ resolved). */
export interface SupportTicketStatusChangedPayload {
  ticketId: string;
  ticketNumber: string;
  openerUserId: string;
  from: TicketStatusValue;
  to: TicketStatusValue;
  actor: 'admin' | 'customer' | 'seller' | 'system';
}

export const SupportTicketStatusChanged = defineEvent<SupportTicketStatusChangedPayload>(
  'support.ticket_status_changed',
  1,
  'support_ticket',
);
