import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { ReturnActorRole, ReturnRefusalReason, ReturnStatus } from '../enums';
import { type ReturnActor, type ReturnRequest } from '../model/return-request.model';
import { type ReturnRequestRepository } from '../repository/return-request.repository';
import { type ReturnCompletionService } from './return-completion.service';
import { type ReturnLifecycleService } from './return-lifecycle.service';

const SYSTEM: ReturnActor = { role: ReturnActorRole.SYSTEM, userId: null };

/**
 * `returns-jobs` (spec 18 UC-RE-9), advisory-locked by the job runner. Candidates are read without
 * locks; each request is then handled in its own short transaction that skips one another transaction
 * holds and re-checks status and deadline under the lock (P5-Q5 pattern). Reads in other modules happen
 * before that transaction.
 */
@injectable()
export class ReturnJobs {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'RETURN_JOBS_BATCH_SIZE'>,
    @inject(TOKENS.ReturnRequestRepository) private readonly requests: ReturnRequestRepository,
    @inject(TOKENS.ReturnLifecycleService) private readonly lifecycle: ReturnLifecycleService,
    @inject(TOKENS.ReturnCompletionService) private readonly completion: ReturnCompletionService,
  ) {}

  /** Returns the number of requests moved on. */
  async run(): Promise<number> {
    return (
      (await this.approveUnanswered()) + (await this.refuseUnescalated()) + (await this.completeUninspected())
    );
  }

  /** `requested` past the seller's deadline → approved by the system (R-14 "silence = approve"). */
  private async approveUnanswered(): Promise<number> {
    return this.forEach(ReturnStatus.REQUESTED, 'seller-decision-timeout', async (found) => {
      const logistics = await this.lifecycle.logisticsOf(found.sellerOrderId);
      return this.tx.run(async (trx) => {
        const locked = await this.lockDue(
          found.id,
          ReturnStatus.REQUESTED,
          (r) => r.sellerDecisionDeadlineAt,
          trx,
        );
        if (!locked) return 0;
        await this.lifecycle.approve(locked, [ReturnStatus.REQUESTED], SYSTEM, null, logistics, trx);
        return 1;
      });
    });
  }

  /** `rejected` past the escalation deadline → refused (`seller_rejected`). */
  private async refuseUnescalated(): Promise<number> {
    return this.forEach(ReturnStatus.REJECTED, 'escalation-lapse', async (found) => {
      const orderNumber = await this.lifecycle.orderNumberOf(found.orderId);
      return this.tx.run(async (trx) => {
        const locked = await this.lockDue(
          found.id,
          ReturnStatus.REJECTED,
          (r) => r.escalationDeadlineAt,
          trx,
        );
        if (!locked) return 0;
        await this.lifecycle.transition(
          locked,
          [ReturnStatus.REJECTED],
          {
            status: ReturnStatus.REFUSED,
            refusalReason: ReturnRefusalReason.SELLER_REJECTED,
            clearRefundPayout: true,
          },
          SYSTEM,
          null,
          orderNumber,
          trx,
        );
        return 1;
      });
    });
  }

  /** `received` past the inspection deadline → completed, restocking nothing (RE-6). */
  private async completeUninspected(): Promise<number> {
    return this.forEach(ReturnStatus.RECEIVED, 'inspection-timeout', async (found) => {
      const context = await this.completion.contextOf(found);
      return this.tx.run(async (trx) => {
        const locked = await this.lockDue(
          found.id,
          ReturnStatus.RECEIVED,
          (r) => r.inspectionDeadlineAt,
          trx,
        );
        if (!locked) return 0;
        await this.completion.complete(
          locked,
          [ReturnStatus.RECEIVED],
          new Map(),
          SYSTEM,
          null,
          context,
          trx,
        );
        return 1;
      });
    });
  }

  /** The request still in `status` and past its deadline, locked; null when it moved on or is busy. */
  private async lockDue(
    id: string,
    status: ReturnStatus,
    deadlineOf: (request: ReturnRequest) => Date | null,
    trx: DbTransaction,
  ): Promise<ReturnRequest | null> {
    const locked = await this.requests.lockById(id, trx, {}, { skipLocked: true });
    const deadline = locked ? deadlineOf(locked) : null;
    if (!locked || locked.status !== status || deadline === null || deadline > this.clock.now()) return null;
    return locked;
  }

  /** One bad request must not stop the batch; it is retried on the next run. */
  private async forEach(
    status: typeof ReturnStatus.REQUESTED | typeof ReturnStatus.REJECTED | typeof ReturnStatus.RECEIVED,
    step: string,
    work: (found: ReturnRequest) => Promise<number>,
  ): Promise<number> {
    const ids = await this.requests.findIdsPastDeadline(
      status,
      this.clock.now(),
      this.env.RETURN_JOBS_BATCH_SIZE,
    );
    let moved = 0;
    for (const id of ids) {
      try {
        const found = await this.requests.findById(id);
        if (found) moved += await work(found);
      } catch (error) {
        this.logger.error('returns job failed for a request', {
          event: 'JOB_RETURN_FAILED',
          step,
          returnId: id,
          error,
        });
      }
    }
    if (moved > 0) this.logger.info('returns moved on by the job', { step, count: moved });
    return moved;
  }
}
