/** Spec 16 §1 (R-8). `seller_onboarding` is for sellers only (chk_support_tickets_seller_onboarding). */
export const TicketCategory = {
  ORDER: 'order',
  PAYMENT: 'payment',
  DELIVERY: 'delivery',
  RETURN: 'return',
  ACCOUNT: 'account',
  SELLER_ONBOARDING: 'seller_onboarding',
  OTHER: 'other',
} as const;
export type TicketCategory = (typeof TicketCategory)[keyof typeof TicketCategory];

/** Spec 16 §1.1. `open` = no admin reply yet. */
export const TicketStatus = {
  OPEN: 'open',
  AWAITING_ADMIN: 'awaiting_admin',
  AWAITING_USER: 'awaiting_user',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

/** Waiting for an admin: the SLA clock runs and `awaiting_admin_since` is set (SU-11, SU-12). */
export const WAITING_FOR_ADMIN_STATUSES: readonly TicketStatus[] = [
  TicketStatus.OPEN,
  TicketStatus.AWAITING_ADMIN,
];

/** Counted by the open-ticket limit (spec 16 §1 limits). */
export const UNFINISHED_STATUSES: readonly TicketStatus[] = [
  TicketStatus.OPEN,
  TicketStatus.AWAITING_ADMIN,
  TicketStatus.AWAITING_USER,
];

export const TicketOpenerRole = {
  CUSTOMER: 'customer',
  SELLER: 'seller',
} as const;
export type TicketOpenerRole = (typeof TicketOpenerRole)[keyof typeof TicketOpenerRole];

/** `system` lines are written by the server (status changes, assignment, auto-close). */
export const MessageKind = {
  MESSAGE: 'message',
  INTERNAL_NOTE: 'internal_note',
  SYSTEM: 'system',
} as const;
export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];

export const SenderRole = {
  CUSTOMER: 'customer',
  SELLER: 'seller',
  ADMIN: 'admin',
  SYSTEM: 'system',
} as const;
export type SenderRole = (typeof SenderRole)[keyof typeof SenderRole];
