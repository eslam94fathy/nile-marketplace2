import { inject, injectable } from 'tsyringe';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { type IPaymentDirectory, PaymentStatus } from '../../payments';
import { ActorRole, OrderStatus, SellerOrderCancelReason, SellerOrderStatus } from '../enums';
import { type OrderRepository } from '../repository/order.repository';
import { type OrderLifecycleService } from './order-lifecycle.service';

const SYSTEM = { role: ActorRole.SYSTEM, userId: null };

/** Rolls back an expiry the webhook beat to it (spec 09 §3.10 step 4). */
class PaymentWonRace extends Error {}

type Outcome = 'expired' | 'skipped';

/**
 * `kashier-payment-expiry` (spec 09 §3.10, OR-5, OR-6; spec 10 PA-11, PA-13). Per order past its
 * window: skip a payment already paid locally; ask Kashier (outside any transaction); a paid session
 * is applied like a webhook, a payment in flight waits for the next run; otherwise one short
 * transaction cancels the seller orders, releases the stock, closes the order and expires the payment,
 * and rolls all of it back if the payment moved on meanwhile.
 */
@injectable()
export class PaymentExpiryJob {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.OrderRepository) private readonly orders: OrderRepository,
    @inject(TOKENS.PaymentDirectory) private readonly payments: IPaymentDirectory,
    @inject(TOKENS.OrderLifecycleService) private readonly lifecycle: OrderLifecycleService,
  ) {}

  /** Returns the number of orders expired. */
  async run(batchSize: number): Promise<number> {
    const orderIds = await this.orders.findIdsPastPaymentExpiry(this.lifecycle.now(), batchSize);
    let expired = 0;
    for (const orderId of orderIds) {
      try {
        if ((await this.expireOne(orderId)) === 'expired') expired += 1;
      } catch (error) {
        // One bad order must not stop the batch; it is retried on the next run.
        this.logger.error('payment expiry failed for an order', {
          event: 'JOB_ORDER_FAILED',
          orderId,
          error,
        });
      }
    }
    return expired;
  }

  private async expireOne(orderId: string): Promise<Outcome> {
    const [payment] = await this.payments.getSummaries([orderId]);
    // The webhook was applied and the payment consumer will place the order (OR-6 a).
    if (payment?.status === PaymentStatus.PAID) return 'skipped';

    const provider = await this.payments.fetchProviderStatus(orderId);
    if (provider === 'paid') {
      await this.payments.markPaidFromProvider(orderId);
      this.logger.info('paid session found at expiry; placed through payment.paid', {
        event: 'PAYMENT_PAID_AT_EXPIRY',
        orderId,
      });
      return 'skipped';
    }
    if (provider === 'pending') {
      this.logger.info('payment in flight at expiry; checked again next run', {
        event: 'PAYMENT_PENDING_AT_EXPIRY',
        orderId,
      });
      return 'skipped';
    }

    // 'unpaid', or 'unknown' (Kashier unreachable): expire; a late success is SD-5.
    try {
      return await this.tx.run(async (trx): Promise<Outcome> => {
        const locked = await this.lifecycle.lock(orderId, trx, { skipLocked: true });
        const now = this.lifecycle.now();
        if (
          !locked ||
          locked.order.status !== OrderStatus.PENDING_PAYMENT ||
          !locked.order.paymentExpiresAt ||
          locked.order.paymentExpiresAt >= now
        ) {
          return 'skipped';
        }
        for (const sellerOrder of locked.sellerOrders) {
          await this.lifecycle.cancelSellerOrder(
            locked,
            sellerOrder.id,
            [SellerOrderStatus.PENDING_PAYMENT],
            { reason: SellerOrderCancelReason.PAYMENT_EXPIRED, note: null },
            SYSTEM,
            trx,
          );
        }
        await this.lifecycle.settle(locked, SYSTEM, trx);
        // Payments is last in the lock order (OR-3).
        if (!(await this.payments.expire(orderId, trx))) throw new PaymentWonRace();
        this.logger.info('kashier order expired unpaid', {
          event: 'ORDER_PAYMENT_EXPIRED',
          orderId,
          provider,
        });
        return 'expired';
      });
    } catch (error) {
      if (error instanceof PaymentWonRace) return 'skipped';
      throw error;
    }
  }
}
