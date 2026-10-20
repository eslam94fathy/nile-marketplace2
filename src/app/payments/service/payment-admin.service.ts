import { inject, injectable } from 'tsyringe';
import { type IAuditRecorder } from '../../../lib/audit';
import { type IClock } from '../../../lib/clock';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, PaymentRefundRecorded } from '../../../lib/events';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ILogger } from '../../../lib/logger';
import { PaymentStatus, RefundStatus } from '../enums';
import { paymentNotFound, refundAlreadyRecorded, refundNotFound } from '../errors';
import { type Payment } from '../model/payment.model';
import { type PaymentEventSummary, type PaymentRefund } from '../model/refund.model';
import { type PaymentEventRepository } from '../repository/payment-event.repository';
import { type PaymentRefundRepository } from '../repository/payment-refund.repository';
import { type PaymentRepository } from '../repository/payment.repository';

export interface AdminPaymentView {
  payment: Payment;
  refunds: PaymentRefund[];
  events: PaymentEventSummary[];
}

/** Spec 10 §4.2: the refund queue, payment details, and recording a manual refund (UC-PA-4). */
@injectable()
export class PaymentAdminService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.PaymentRepository) private readonly payments: PaymentRepository,
    @inject(TOKENS.PaymentRefundRepository) private readonly refunds: PaymentRefundRepository,
    @inject(TOKENS.PaymentEventRepository) private readonly events: PaymentEventRepository,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
  ) {}

  async listRefunds(query: ParsedListQuery): Promise<{ items: PaymentRefund[]; meta: PageMeta }> {
    return toPage(await this.refunds.list(query), query, (refund) => refund.createdAt);
  }

  async getPayment(paymentId: string): Promise<AdminPaymentView> {
    return this.viewOf(await this.payments.findById(paymentId));
  }

  async getPaymentOfOrder(orderId: string): Promise<AdminPaymentView> {
    return this.viewOf(await this.payments.findByOrderId(orderId));
  }

  /**
   * UC-PA-4, one transaction with the payment row locked: the refund `pending_manual → recorded`,
   * `refunded_amount += amount`, status `refunded_manually` once everything collected went back,
   * else `partially_refunded_manually`, and `payment.refund_recorded`.
   */
  async recordRefund(
    refundId: string,
    adminUserId: string,
    providerRefundRef: string,
  ): Promise<PaymentRefund> {
    const found = await this.refunds.findById(refundId);
    if (!found) throw refundNotFound();
    await this.tx.run(async (trx) => {
      const payment = await this.payments.lockById(found.paymentId, trx);
      if (!payment) throw new Error(`refund ${refundId} has no payment`);
      const recorded = await this.refunds.markRecorded(
        refundId,
        { providerRefundRef, recordedByUserId: adminUserId, recordedAt: this.clock.now() },
        trx,
      );
      if (!recorded) throw refundAlreadyRecorded();
      await this.audit.record(
        {
          action: 'payment_refund.recorded',
          targetId: refundId,
          before: { status: found.status, providerRefundRef: found.providerRefundRef },
          after: { status: RefundStatus.RECORDED, providerRefundRef },
        },
        trx,
      );

      const refundedAmount = payment.refundedAmount.plus(found.amount);
      const status = refundedAmount.equals(payment.collectedAmount)
        ? PaymentStatus.REFUNDED_MANUALLY
        : PaymentStatus.PARTIALLY_REFUNDED_MANUALLY;
      // chk_payments_refunded_amount refuses more than was collected (a 422 through the PG error map).
      await this.payments.setRefunded(payment.id, refundedAmount, status, trx);
      await this.outbox.add(trx, {
        contract: PaymentRefundRecorded,
        aggregateId: payment.id,
        payload: {
          paymentId: payment.id,
          orderId: payment.orderId,
          refundId,
          amount: found.amount.toString(),
          newPaymentStatus: status,
          recordedByUserId: adminUserId,
        },
      });
      this.logger.info('manual refund recorded', {
        event: 'REFUND_RECORDED',
        refundId,
        paymentId: payment.id,
        amount: found.amount.toString(),
        newStatus: status,
      });
    });
    const after = await this.refunds.findById(refundId);
    if (!after) throw refundNotFound();
    return after;
  }

  private async viewOf(payment: Payment | null): Promise<AdminPaymentView> {
    if (!payment) throw paymentNotFound();
    const [refunds, events] = await Promise.all([
      this.refunds.listByPaymentId(payment.id),
      this.events.listByPaymentId(payment.id),
    ]);
    return { payment, refunds, events };
  }
}
