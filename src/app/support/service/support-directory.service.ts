import { inject, injectable } from 'tsyringe';
import { UserRole } from '../../../lib/auth';
import { TOKENS } from '../../../lib/di';
import { type SupportStats, type TicketState } from '../model/support-ticket.model';
import { type SupportTicketRepository } from '../repository/support-ticket.repository';

/** Public API of support (spec 16 §2). */
export interface ISupportDirectory {
  /** The opener, or any admin (realtime `ticket.subscribe`, spec 15). False for a missing ticket. */
  canView(userId: string, role: UserRole, ticketId: string): Promise<boolean>;
  /** Back-office dashboard counts (spec 20 §3.2), one aggregate query. */
  getStats(): Promise<SupportStats>;
  /**
   * Current status and assignee, batched (realtime `support.ticket_updated`, spec 15 §3.1): re-read so a
   * late event still shows the current state (SU-19). Unknown ids are left out.
   */
  getTicketStates(ticketIds: readonly string[]): Promise<Map<string, TicketState>>;
}

@injectable()
export class SupportDirectory implements ISupportDirectory {
  constructor(@inject(TOKENS.SupportTicketRepository) private readonly tickets: SupportTicketRepository) {}

  canView(userId: string, role: UserRole, ticketId: string): Promise<boolean> {
    if (role === UserRole.ADMIN) return this.tickets.exists(ticketId);
    if (role === UserRole.CUSTOMER || role === UserRole.SELLER) return this.tickets.exists(ticketId, userId);
    return Promise.resolve(false);
  }

  getStats(): Promise<SupportStats> {
    return this.tickets.getStats();
  }

  getTicketStates(ticketIds: readonly string[]): Promise<Map<string, TicketState>> {
    return this.tickets.findStates(ticketIds);
  }
}
