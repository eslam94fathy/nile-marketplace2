import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, PaymentFailed, PaymentPaid } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { type Money } from '../../../lib/money';
import { PaymentMethod, PaymentStatus, RefundReason } from '../enums';
import { type Payment } from '../model/payment.model';
import { type PaymentRefundRepository } from '../repository/payment-refund.repository';
import { type PaymentRepository } from '../repository/payment.repository';

/** Money taken by Kashier, as reported by a webhook or a session read. */
export interface ProviderPayment {
  /** null when only the session read reported it (no transaction id there). */
  transactionRef: string | null;
  amount: Money;
  paidAt: Date;
}

export type SettlementOutcome = 'paid' | 'late_paid' | 'amount_mismatch' | 'already_settled' | 'not_kashier';

/**
 * Spec 10 UC-PA-2 (and the amount check of UC-PA-1 step 4), in the caller's transaction on a payment
 * row it has locked: `initiated → paid`, or `expired → paid` with a full refund flagged (SD-5); an
 * amount that isn't the payment's is `failed` with a refund flagged (PA-6). Shared by the webhook and
 * the expiry job's provider check (`markPaidFromProvider`).
 */
@injectable()
export class PaymentSettlementService {
  constructor(
    @inject(TOKENS.PaymentRepository) private readonly payments: PaymentRepository,
    @inject(TOKENS.PaymentRefundRepository) private readonly refunds: PaymentRefundRepository,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async applySuccess(
    payment: Payment,
    paid: ProviderPayment,
    trx: DbTransaction,
  ): Promise<SettlementOutcome> {
    const fields = { paymentId: payment.id, orderId: payment.orderId, status: payment.status };
    if (payment.method !== PaymentMethod.KASHIER) {
      this.logger.error('provider payment reported for a COD payment', {
        event: 'KASHIER_COD_PAYMENT',
        ...fields,
      });
      return 'not_kashier';
    }
    const open = [PaymentStatus.INITIATED, PaymentStatus.EXPIRED] as const;
    if (!(open as readonly PaymentStatus[]).includes(payment.status)) {
      this.logger.info('provider payment already applied', { event: 'PAYMENT_ALREADY_SETTLED', ...fields });
      return 'already_settled';
    }

    const update = {
      collectedAmount: paid.amount,
      providerTransactionRef: paid.transactionRef,
      paidAt: paid.paidAt,
    };
    if (!paid.amount.equals(payment.amount)) {
      await this.payments.transition(payment.id, open, PaymentStatus.FAILED, trx, update);
      await this.refunds.insertPending(
        {
          paymentId: payment.id,
          sellerOrderId: null,
          amount: paid.amount,
          reason: RefundReason.AMOUNT_MISMATCH,
        },
        trx,
      );
      await this.outbox.add(trx, {
        contract: PaymentFailed,
        aggregateId: payment.id,
        payload: { paymentId: payment.id, orderId: payment.orderId, reason: 'amount_mismatch' },
      });
      this.logger.error('paid amount differs from the payment', {
        event: 'PAYMENT_AMOUNT_MISMATCH',
        ...fields,
        expected: payment.amount.toString(),
        paid: paid.amount.toString(),
      });
      return 'amount_mismatch';
    }

    const late = payment.status === PaymentStatus.EXPIRED;
    await this.payments.transition(payment.id, open, PaymentStatus.PAID, trx, update);
    if (late) {
      // SD-5: the order stays cancelled; the whole amount goes back.
      await this.refunds.insertPending(
        {
          paymentId: payment.id,
          sellerOrderId: null,
          amount: paid.amount,
          reason: RefundReason.LATE_PAYMENT_AFTER_EXPIRY,
        },
        trx,
      );
    }
    await this.outbox.add(trx, {
      contract: PaymentPaid,
      aggregateId: payment.id,
      payload: {
        paymentId: payment.id,
        orderId: payment.orderId,
        amount: paid.amount.toString(),
        paidAt: paid.paidAt.toISOString(),
        lateAfterExpiry: late,
      },
    });
    this.logger.info(late ? 'payment succeeded after expiry; refund flagged' : 'payment succeeded', {
      event: late ? 'PAYMENT_PAID_LATE' : 'PAYMENT_PAID',
      ...fields,
    });
    return late ? 'late_paid' : 'paid';
  }
}
