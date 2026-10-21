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
