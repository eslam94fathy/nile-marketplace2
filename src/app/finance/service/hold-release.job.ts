import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { type IReturnsDirectory } from '../../returns';
import { holdReleaseBooking } from '../model/booking-rules';
import { type SellerOrderHoldRepository } from '../repository/seller-order-hold.repository';
import { type LedgerService } from './ledger.service';

/**
 * `seller-hold-release` (spec 12 §8.3, R-16), worker only, advisory-locked by the job runner. Holds past
 * their window are read without locks; those whose seller order has an open return wait for a later run
 * (no new return can start after the window). Each hold is released in its own short transaction:
 * the hold locked first, then the accounts (FI-18).
 */
@injectable()
export class HoldReleaseJob {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'SELLER_HOLD_BATCH_SIZE'>,
    @inject(TOKENS.SellerOrderHoldRepository) private readonly holds: SellerOrderHoldRepository,
    @inject(TOKENS.LedgerService) private readonly ledger: LedgerService,
    @inject(TOKENS.ReturnsDirectory) private readonly returns: IReturnsDirectory,
  ) {}

  /** Returns the number of holds released. */
  async run(): Promise<number> {
    const ids = await this.holds.findDueIds(this.clock.now(), this.env.SELLER_HOLD_BATCH_SIZE);
    if (ids.length === 0) return 0;
    const blocked = await this.returns.getOpenReturnSellerOrderIds(ids);
    let released = 0;
    for (const sellerOrderId of ids.filter((id) => !blocked.has(id))) {
      try {
        released += await this.tx.run(async (trx) => {
          const hold = await this.holds.lock(sellerOrderId, trx, { skipLocked: true });
          if (!hold || hold.releasedAt !== null) return 0;
          await this.ledger.post(holdReleaseBooking(hold), trx);
          await this.holds.markReleased(sellerOrderId, this.clock.now(), trx);
          return 1;
        });
      } catch (error) {
        // One bad hold must not stop the batch; it is retried on the next run.
        this.logger.error('hold release failed', { event: 'JOB_HOLD_RELEASE_FAILED', sellerOrderId, error });
      }
    }
    if (released > 0 || blocked.size > 0) {
      this.logger.info('seller holds released', {
        event: 'SELLER_HOLDS_RELEASED',
        released,
        waitingOnReturns: blocked.size,
      });
    }
    return released;
  }
}
