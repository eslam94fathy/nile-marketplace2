import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, PaymentRefunded } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { Money } from '../../../lib/money';
import { type IPaymentGateway, PaymentGatewayError, type RefundResult } from '../../../pkg/payments';
import { addDuration, TimeUnit } from '../../../pkg/time';
import { REFUND_BACKOFF_MINUTES, REFUND_SPACING_MINUTES, RefundLogEvent } from '../constants';
import { PaymentStatus, RefundStatus } from '../enums';
import { type PaymentRefund } from '../model/refund.model';
import { type PaymentRefundRepository } from '../repository/payment-refund.repository';
import { type PaymentRepository } from '../repository/payment.repository';

type RefundJobEnv = Pick<
  Env,
  'PAYMENT_REFUND_BATCH_SIZE' | 'PAYMENT_REFUND_MAX_ATTEMPTS' | 'PAYMENT_REFUND_STUCK_MINUTES'
>;

/**
 * `payment-refunds` (spec 10 UC-PA-6, K-8…K-12), worker only, advisory-locked by the job runner.
 * Candidates are read without locks; each refund is claimed in a short transaction (`processing`), the
 * Kashier call runs outside any transaction, and its result is applied in another one that locks the
 * payment, then the refund (payments' lock order, PA-2). Nothing is ever re-sent blindly (PA-24, K-10).
 */
@injectable()
export class RefundJob {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.Env) private readonly env: RefundJobEnv,
    @inject(TOKENS.PaymentGateway) private readonly gateway: IPaymentGateway,
    @inject(TOKENS.PaymentRepository) private readonly payments: PaymentRepository,
    @inject(TOKENS.PaymentRefundRepository) private readonly refunds: PaymentRefundRepository,
  ) {}

  /** Returns the number of refunds that reached Kashier or the manual queue in this run. */
  async run(): Promise<number> {
    let handled = await this.releaseStuck();
    for (const id of await this.refunds.findDueIds(this.clock.now(), this.env.PAYMENT_REFUND_BATCH_SIZE)) {
      try {
        if (await this.process(id)) handled += 1;
      } catch (error) {
        // One bad refund must not stop the batch; it stays `processing` and the stuck check takes it.
        this.logger.error('refund job failed for a refund', {
          event: 'JOB_REFUND_FAILED',
          refundId: id,
          error,
        });
      }
    }
    return handled;
  }

  /** §8.3 step 4, K-10: a refund left `processing` may have run; only an admin can tell. */
  private async releaseStuck(): Promise<number> {
    const before = addDuration(this.clock.now(), -this.env.PAYMENT_REFUND_STUCK_MINUTES, TimeUnit.MINUTE);
    let released = 0;
    for (const id of await this.refunds.findStuckIds(before, this.env.PAYMENT_REFUND_BATCH_SIZE)) {
      released += await this.tx.run(async (trx) => {
        const refund = await this.refunds.lockById(id, trx, { skipLocked: true });
        if (refund?.status !== RefundStatus.PROCESSING) return 0;
        await this.refunds.markManual(id, `${RefundLogEvent.OUTCOME_UNKNOWN}: processing for too long`, trx);
        this.logger.warn('refund outcome unknown: left processing', {
          event: RefundLogEvent.OUTCOME_UNKNOWN,
          refundId: id,
          paymentId: refund.paymentId,
        });
        return 1;
      });
    }
    return released;
  }

  /** One refund: claim, call Kashier, apply the result. false = not claimed (busy, moved on, or spaced). */
  private async process(id: string): Promise<boolean> {
    const claimed = await this.claim(id);
    if (!claimed) return false;
    let result: RefundResult;
    try {
      result = await this.gateway.refund({
        merchantOrderId: claimed.paymentId,
        amount: claimed.amount.toString(),
        reason: `Nile refund ${claimed.reason}`,
      });
    } catch (error) {
      await this.failed(claimed, error);
      return true;
    }
    await this.succeeded(claimed, result);
    return true;
  }

  /**
   * UC-PA-6 step 1, with the K-11 spacing: a payment with a refund attempt in the last minutes waits, and so
   * does a payment with a refund of unknown or replayed outcome until an admin resolves it (K-13).
   */
  private claim(id: string): Promise<PaymentRefund | null> {
    const now = this.clock.now();
    return this.tx.run(async (trx) => {
      const refund = await this.refunds.lockById(id, trx, { skipLocked: true });
      if (
        refund?.status !== RefundStatus.PENDING_AUTO ||
        !refund.nextAttemptAt ||
        refund.nextAttemptAt > now
      ) {
        return null;
      }
      const since = addDuration(now, -REFUND_SPACING_MINUTES, TimeUnit.MINUTE);
      const unresolved = [RefundLogEvent.OUTCOME_UNKNOWN, RefundLogEvent.REPLAYED];
      if (await this.refunds.hasRecentAttempt(refund.paymentId, refund.id, since, unresolved, trx)) {
        await this.refunds.defer(id, addDuration(now, REFUND_SPACING_MINUTES, TimeUnit.MINUTE), trx);
        return null;
      }
      await this.refunds.markProcessing(id, trx);
      return { ...refund, status: RefundStatus.PROCESSING, attemptCount: refund.attemptCount + 1 };
    });
  }

  /**
   * Success, accepted only when it is a new refund (K-11): Kashier's transaction id is on none of the
   * payment's refunds, and its total is what the payment refunded so far plus this one. Then the payment
   * is `partially_refunded` / `refunded` and `payment.refunded` is published.
   */
  private async succeeded(refund: PaymentRefund, result: RefundResult): Promise<void> {
    await this.tx.run(async (trx) => {
      const payment = await this.payments.lockById(refund.paymentId, trx);
      if (!payment) throw new Error(`refund ${refund.id} has no payment`);
      const locked = await this.refunds.lockById(refund.id, trx);
      if (locked?.status !== RefundStatus.PROCESSING) throw new Error(`refund ${refund.id} left processing`);
      const refundedAmount = payment.refundedAmount.plus(refund.amount);
      const replayed =
        (await this.refunds.hasProviderRef(payment.id, result.refundTransactionId, trx)) ||
        !Money.of(result.totalRefundedAmount).equals(refundedAmount);
      if (replayed) {
        const why = `${RefundLogEvent.REPLAYED}: transaction ${result.refundTransactionId}, Kashier total ${result.totalRefundedAmount}, expected ${refundedAmount.toString()}`;
        await this.refunds.markManual(refund.id, why, trx);
        this.logger.error('Kashier answered a refund that may not have run; an admin checks the dashboard', {
          event: RefundLogEvent.REPLAYED,
          refundId: refund.id,
          paymentId: payment.id,
          providerRefundRef: result.refundTransactionId,
          kashierTotal: result.totalRefundedAmount,
          expectedTotal: refundedAmount.toString(),
        });
        return;
      }
      const now = this.clock.now();
      await this.refunds.markSucceeded(refund.id, result.refundTransactionId, now, trx);
      const status = refundedAmount.equals(payment.collectedAmount)
        ? PaymentStatus.REFUNDED
        : PaymentStatus.PARTIALLY_REFUNDED;
      await this.payments.setRefunded(payment.id, refundedAmount, status, trx);
      await this.outbox.add(trx, {
        contract: PaymentRefunded,
        aggregateId: payment.id,
        payload: {
          paymentId: payment.id,
          orderId: payment.orderId,
          customerId: payment.customerId,
          refundId: refund.id,
          returnId: refund.returnId,
          reason: refund.reason,
          amount: refund.amount.toString(),
          newPaymentStatus: status,
        },
      });
      this.logger.info('refund done through Kashier', {
        event: RefundLogEvent.SUCCEEDED,
        refundId: refund.id,
        paymentId: payment.id,
        amount: refund.amount.toString(),
        newStatus: status,
      });
    });
  }

  /** K-12: transient → backoff (manual once the attempts run out); refused or unknown → manual. */
  private async failed(refund: PaymentRefund, error: unknown): Promise<void> {
    const kind = error instanceof PaymentGatewayError ? error.kind : 'unknown_outcome';
    const message = error instanceof Error ? error.message : String(error);
    const fields = { refundId: refund.id, paymentId: refund.paymentId, attempt: refund.attemptCount, error };
    await this.tx.run(async (trx) => {
      if (kind === 'unavailable') {
        if (refund.attemptCount >= this.env.PAYMENT_REFUND_MAX_ATTEMPTS) {
          await this.refunds.markManual(refund.id, `${RefundLogEvent.GAVE_UP}: ${message}`, trx);
          this.logger.error('refund gave up after its attempts; an admin takes over', {
            event: RefundLogEvent.GAVE_UP,
            ...fields,
          });
          return;
        }
        const minutes =
          REFUND_BACKOFF_MINUTES[Math.min(refund.attemptCount, REFUND_BACKOFF_MINUTES.length) - 1] ?? 1;
        await this.refunds.markRetry(
          refund.id,
          addDuration(this.clock.now(), minutes, TimeUnit.MINUTE),
          message,
          trx,
        );
        this.logger.warn('refund failed for now; retried later', {
          event: RefundLogEvent.RETRY,
          ...fields,
          minutes,
        });
        return;
      }
      if (kind === 'rejected' || kind === 'session_exists') {
        await this.refunds.markManual(refund.id, `${RefundLogEvent.REJECTED}: ${message}`, trx);
        this.logger.error('Kashier refused a refund; an admin takes over', {
          event: RefundLogEvent.REJECTED,
          ...fields,
        });
        return;
      }
      await this.refunds.markManual(refund.id, `${RefundLogEvent.OUTCOME_UNKNOWN}: ${message}`, trx);
      this.logger.warn('refund outcome unknown; an admin checks the Kashier dashboard', {
        event: RefundLogEvent.OUTCOME_UNKNOWN,
        ...fields,
      });
    });
  }
}
