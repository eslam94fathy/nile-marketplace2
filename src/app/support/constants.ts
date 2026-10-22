export const SUPPORT_TABLES = {
  TICKETS: 'support_tickets',
  MESSAGES: 'support_messages',
  MESSAGE_ATTACHMENTS: 'support_message_attachments',
  TICKET_READS: 'support_ticket_reads',
} as const;

/** Spec 16 §1 limits (constants; the per-user open-ticket limit and the SLA timings are env). */
export const SUPPORT_LIMITS = {
  SUBJECT_MIN: 3,
  SUBJECT_MAX: 150,
  BODY_MIN: 1,
  BODY_MAX: 4000,
  MAX_ATTACHMENTS: 3,
} as const;

/** `'T-' || lpad(nextval(...)::text, 9, '0')` (SU-16, as order numbers). */
export const TICKET_NUMBER = {
  SEQUENCE: 'support_ticket_number_seq',
  PREFIX: 'T-',
  DIGITS: 9,
} as const;

/** Log event codes (spec 16 §6). */
export const SupportLogEvent = {
  SLA_BREACHED: 'SUPPORT_SLA_BREACHED',
} as const;

/** How users see every admin and the server (SU-3); admins see each other by email (SU-7). */
export const SUPPORT_DISPLAY_NAME = 'Nile Support';

/** The bodies of the server-written timeline lines (spec 16 §1.1). */
export const SYSTEM_LINES = {
  REOPENED: 'Ticket reopened',
  ASSIGNED: 'Ticket assigned to a support agent',
  UNASSIGNED: 'Ticket unassigned',
  RESOLVED: 'Resolved by support',
  CLOSED: 'Closed by support',
  AUTO_CLOSED: 'Closed automatically after being resolved',
} as const;

/** Paths under /api/v1 (spec 16 §4.1). */
export const SUPPORT_PATHS = {
  TICKETS: '/support/tickets',
  TICKET: '/support/tickets/:ticketId',
  MESSAGES: '/support/tickets/:ticketId/messages',
  READ: '/support/tickets/:ticketId/read',
} as const;

/** Paths under /api/v1 (spec 16 §4.2). */
export const ADMIN_SUPPORT_PATHS = {
  TICKETS: '/admin/support/tickets',
  TICKET: '/admin/support/tickets/:ticketId',
  MESSAGES: '/admin/support/tickets/:ticketId/messages',
  ASSIGN: '/admin/support/tickets/:ticketId/assign',
  RESOLVE: '/admin/support/tickets/:ticketId/resolve',
  CLOSE: '/admin/support/tickets/:ticketId/close',
  READ: '/admin/support/tickets/:ticketId/read',
} as const;
