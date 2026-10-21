import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { addDuration, TimeUnit } from '../../../pkg/time';
import { SupportLogEvent, SYSTEM_LINES } from '../constants';
import { SenderRole, TicketStatus, WAITING_FOR_ADMIN_STATUSES } from '../enums';
import { type SupportTicketRepository } from '../repository/support-ticket.repository';
import { systemLine, type SupportTimelineService } from './support-timeline.service';

type JobEnv = Pick<Env, 'SUPPORT_SLA_HOURS' | 'SUPPORT_AUTO_CLOSE_AFTER_HOURS' | 'SUPPORT_JOBS_BATCH_SIZE'>;

/**
 * `support-jobs` (spec 16 UC-SU-5), advisory-locked by the job runner. Candidates are read without locks;
 * each ticket is then handled in its own short transaction that skips a ticket another transaction
 * holds and re-checks the condition under the lock (P5-Q5 pattern), so a user reopening a ticket or an
 * admin replying at the same moment wins or loses cleanly.
 */
@injectable()
export class SupportJobs {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.Env) private readonly env: JobEnv,
    @inject(TOKENS.SupportTicketRepository) private readonly tickets: SupportTicketRepository,
    @inject(TOKENS.SupportTimelineService) private readonly timeline: SupportTimelineService,
  ) {}

  /** Returns the number of tickets closed or flagged. */
  async run(): Promise<number> {
    return (await this.autoClose()) + (await this.flagSlaBreaches());
  }

  /** `resolved` for longer than SUPPORT_AUTO_CLOSE_AFTER_HOURS → `closed` (actor `system`). */
  private async autoClose(): Promise<number> {
    const cutoff = addDuration(this.clock.now(), -this.env.SUPPORT_AUTO_CLOSE_AFTER_HOURS, TimeUnit.HOUR);
    const ids = await this.tickets.findResolvedBefore(cutoff, this.env.SUPPORT_JOBS_BATCH_SIZE);
    let closed = 0;
    for (const id of ids) {
      closed += await this.each(id, 'auto-close', () =>
        this.tx.run(async (trx) => {
          const locked = await this.tickets.lockById(id, trx, { skipLocked: true });
          if (locked?.status !== TicketStatus.RESOLVED || !locked.resolvedAt || locked.resolvedAt >= cutoff) {
            return 0;
          }
          const at = this.clock.now();
          const created = await this.timeline.append([systemLine(id, SYSTEM_LINES.AUTO_CLOSED)], trx);
          const ticket = await this.tickets.update(
            id,
            { status: TicketStatus.CLOSED, closedAt: at, lastMessageAt: at },
            trx,
          );
          await this.timeline.messagesCreated(ticket, created, trx);
          await this.timeline.statusChanged(ticket, locked.status, SenderRole.SYSTEM, trx);
          return 1;
        }),
      );
    }
    if (closed > 0) this.logger.info('support tickets closed automatically', { count: closed });
    return closed;
  }

  /**
   * Waiting for an admin longer than SUPPORT_SLA_HOURS → `sla_breached_at` + warn. The flag stays as the
   * history of this wait; a new wait clears it (SU-11).
   */
  private async flagSlaBreaches(): Promise<number> {
    const cutoff = addDuration(this.clock.now(), -this.env.SUPPORT_SLA_HOURS, TimeUnit.HOUR);
    const ids = await this.tickets.findWaitingSince(cutoff, this.env.SUPPORT_JOBS_BATCH_SIZE);
    let flagged = 0;
    for (const id of ids) {
      flagged += await this.each(id, 'sla-flag', () =>
        this.tx.run(async (trx) => {
          const locked = await this.tickets.lockById(id, trx, { skipLocked: true });
          const since = locked?.awaitingAdminSince;
          if (
            !locked ||
            !WAITING_FOR_ADMIN_STATUSES.includes(locked.status) ||
            locked.slaBreachedAt !== null ||
            !since ||
            since >= cutoff
          ) {
            return 0;
          }
          await this.tickets.update(id, { slaBreachedAt: this.clock.now() }, trx);
          this.logger.warn('support ticket waited past the SLA', {
            event: SupportLogEvent.SLA_BREACHED,
            ticketId: id,
            ticketNumber: locked.ticketNumber,
            awaitingAdminSince: since.toISOString(),
          });
          return 1;
        }),
      );
    }
    return flagged;
  }

  /** One bad ticket must not stop the batch; it is retried on the next run. */
  private async each(ticketId: string, step: string, work: () => Promise<number>): Promise<number> {
    try {
      return await work();
    } catch (error) {
      this.logger.error('support job failed for a ticket', {
        event: 'JOB_TICKET_FAILED',
        step,
        ticketId,
        error,
      });
      return 0;
    }
  }
}
