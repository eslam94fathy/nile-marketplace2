/**
 * support module (docs/spec/16-support.md): tickets between customers / sellers and the admins.
 * Owns tables: support_tickets, support_messages, support_message_attachments, support_ticket_reads.
 * No other module reads or writes them.
 * May call: ordering (order links), customers, sellers (names in admin views), identity (assignees,
 * admin emails), media (attachments); audit rows go through lib/audit. Read by realtime (`canView`)
 * and from R2-P5 the back-office (`getStats`).
 */
import { type DependencyContainer } from 'tsyringe';
import { TOKENS } from '../../lib/di';
import { SupportTicketRepository } from './repository/support-ticket.repository';
import { SupportDirectory } from './service/support-directory.service';

export { SupportErrorCode } from './errors';
export { TicketCategory, TicketStatus, TicketOpenerRole, MessageKind } from './enums';
export type { SupportStats } from './model/support-ticket.model';
/** Inject with `TOKENS.SupportDirectory`. */
export type { ISupportDirectory } from './service/support-directory.service';

/** The public lookups only (`ISupportDirectory`), for the realtime gateway and the back-office. */
export function registerSupportLookups(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.SupportTicketRepository, SupportTicketRepository);
  container.registerSingleton(TOKENS.SupportDirectory, SupportDirectory);
}
