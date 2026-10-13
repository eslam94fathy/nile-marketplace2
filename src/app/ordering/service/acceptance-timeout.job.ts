import { inject, injectable } from 'tsyringe';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { ActorRole, SellerOrderCancelReason, SellerOrderStatus } from '../enums';
import { type SellerOrderRepository } from '../repository/seller-order.repository';
import { type OrderLifecycleService } from './order-lifecycle.service';

const SYSTEM = { role: ActorRole.SYSTEM, userId: null };

/**
 * `seller-acceptance-timeout` (spec 09 §3.10, OR-5): placed seller orders past their deadline are
 * cancelled with `seller_acceptance_timeout`. Candidates are read without locks; each order is then
 * handled in its own short transaction that skips an order another transaction holds, and re-checks
 * the deadline and status under the lock, so a seller accepting at the same moment wins or loses cleanly.
 */
@injectable()
export class AcceptanceTimeoutJob {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.SellerOrderRepository) private readonly sellerOrders: SellerOrderRepository,
    @inject(TOKENS.OrderLifecycleService) private readonly lifecycle: OrderLifecycleService,
  ) {}

  /** Returns the number of seller orders cancelled. */
  async run(batchSize: number): Promise<number> {
    const orderIds = await this.sellerOrders.findOrderIdsPastAcceptDeadline(this.lifecycle.now(), batchSize);
    let cancelled = 0;
    for (const orderId of orderIds) {
      try {
        cancelled += await this.timeOut(orderId);
      } catch (error) {
        // One bad order must not stop the batch; it is retried on the next run.
        this.logger.error('acceptance timeout failed for an order', {
          event: 'JOB_ORDER_FAILED',
          orderId,
          error,
        });
      }
    }
    return cancelled;
  }

  private timeOut(orderId: string): Promise<number> {
    return this.tx.run(async (trx) => {
      const locked = await this.lifecycle.lock(orderId, trx, { skipLocked: true });
      if (!locked) return 0;
      const now = this.lifecycle.now();
      const expired = locked.sellerOrders.filter(
        (s) =>
          s.status === SellerOrderStatus.PLACED && s.acceptDeadlineAt !== null && s.acceptDeadlineAt < now,
      );
      for (const sellerOrder of expired) {
        await this.lifecycle.cancelSellerOrder(
          locked,
          sellerOrder.id,
          [SellerOrderStatus.PLACED],
          { reason: SellerOrderCancelReason.SELLER_ACCEPTANCE_TIMEOUT, note: null },
          SYSTEM,
          trx,
        );
      }
      if (expired.length > 0) {
        await this.lifecycle.settle(locked, SYSTEM, trx);
        this.logger.info('seller orders timed out', {
          event: 'SELLER_ACCEPTANCE_TIMEOUT',
          orderId,
          sellerOrderIds: expired.map((s) => s.id),
        });
      }
      return expired.length;
    });
  }
}
