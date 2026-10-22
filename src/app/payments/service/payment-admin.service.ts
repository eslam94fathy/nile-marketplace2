import { inject, injectable } from 'tsyringe';
import { type IAuditRecorder } from '../../../lib/audit';
import { type IClock } from '../../../lib/clock';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { internalError } from '../../../lib/error';
import { type IOutbox, PaymentRefundRecorded, refundPayoutAad } from '../../../lib/events';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ILogger } from '../../../lib/logger';
import { type ISecretBox } from '../../../pkg/crypto';
import { PaymentMethod, PaymentStatus, RefundStatus } from '../enums';
import { paymentNotFound, refundAlreadyRecorded, refundNotFound, refundNotRetryable } from '../errors';
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

/** Where a COD return refund is paid (spec 18 RE-8), as the customer gave it. Never logged. */
export type RefundPayoutDetails =
  { method: 'mobile_wallet'; walletNumber: string } | { method: 'instapay'; instapayAddress: string };

/** `GET /admin/payments/refunds/:refundId` (spec 10 §8.4): the refund, and the opened payout details. */
export interface AdminRefundView {
  refund: PaymentRefund;
  payoutDetails: RefundPayoutDetails | null;
}

/**
 * Spec 10 §4.2, §8.4: the refund queue over every status, the refund detail, recording a refund done by
 * hand (UC-PA-4: Kashier dashboard or a COD transfer) and handing a Kashier refund to the job.
 */
@injectable()
export class PaymentAdminService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.SecretBox) private readonly secretBox: ISecretBox,
    @inject(TOKENS.PaymentRepository) private readonly payments: PaymentRepository,
    @inject(TOKENS.PaymentRefundRepository) private readonly refunds: PaymentRefundRepository,
    @inject(TOKENS.PaymentEventRepository) private readonly events: PaymentEventRepository,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
  ) {}

  async listRefunds(query: ParsedListQuery): Promise<{ items: PaymentRefund[]; meta: PageMeta }> {
    return toPage(await this.refunds.list(query), query, (refund) => refund.createdAt);
  }

  /** The detail opens the COD payout details (spec 10 §8.4); they are never logged or listed. */
  async getRefund(refundId: string): Promise<AdminRefundView> {
    const refund = await this.refunds.findById(refundId);
    if (!refund) throw refundNotFound();
    if (!refund.hasPayoutDetails || refund.returnId === null) return { refund, payoutDetails: null };
    const sealed = await this.refunds.findPayoutDetails(refund.id);
    if (sealed === null) return { refund, payoutDetails: null };
    try {
      const details = JSON.parse(
        this.secretBox.open(sealed, refundPayoutAad(refund.returnId)),
      ) as RefundPayoutDetails;
      return { refund, payoutDetails: details };
    } catch (cause) {
      // A key-ring or data defect; the details stay out of the logs.
      throw internalError(new Error(`refund ${refund.id}: payout details could not be opened`, { cause }));
    }
  }

  async getPayment(paymentId: string): Promise<AdminPaymentView> {
    return this.viewOf(await this.payments.findById(paymentId));
  }

  async getPaymentOfOrder(orderId: string): Promise<AdminPaymentView> {
    return this.viewOf(await this.payments.findByOrderId(orderId));
  }

  /**
   * UC-PA-4, one transaction with the payment row locked: the refund `pending_manual → recorded`,
   * `refunded_amount += amount` and `payment.refund_recorded`. A Kashier payment becomes `refunded` once
   * everything collected went back, else `partially_refunded`; a COD payment keeps its status (spec 10
   * §8.1).
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
      const kashier = payment.method === PaymentMethod.KASHIER;
      const newStatus = kashier
        ? refundedAmount.equals(payment.collectedAmount)
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED
        : null;
      // chk_payments_refunded_amount refuses more than was collected (a 422 through the PG error map).
      await this.payments.setRefunded(payment.id, refundedAmount, newStatus ?? payment.status, trx);
      await this.outbox.add(trx, {
        contract: PaymentRefundRecorded,
        aggregateId: payment.id,
        payload: {
          paymentId: payment.id,
          orderId: payment.orderId,
          refundId,
          customerId: payment.customerId,
          reason: found.reason,
          returnId: found.returnId,
          amount: found.amount.toString(),
          newPaymentStatus: newStatus,
          recordedByUserId: adminUserId,
        },
      });
      this.logger.info('manual refund recorded', {
        event: 'REFUND_RECORDED',
        refundId,
        paymentId: payment.id,
        amount: found.amount.toString(),
        newStatus: newStatus ?? payment.status,
      });
    });
    const after = await this.refunds.findById(refundId);
    if (!after) throw refundNotFound();
    return after;
  }

  /**
   * `POST …/retry` (spec 10 §8.4, PA-29): a `pending_manual` Kashier refund goes to the job at once with
   * its attempts reset, after the admin fixed the cause. Anything else is `409 REFUND_NOT_RETRYABLE`.
   */
  async retryRefund(refundId: string): Promise<PaymentRefund> {
    const found = await this.refunds.findById(refundId);
    if (!found) throw refundNotFound();
    const payment = await this.payments.findById(found.paymentId);
    if (payment?.method !== PaymentMethod.KASHIER) throw refundNotRetryable();
    await this.tx.run(async (trx) => {
      if (!(await this.refunds.markRetriedByAdmin(refundId, this.clock.now(), trx)))
        throw refundNotRetryable();
      await this.audit.record(
        {
          action: 'payment_refund.retried',
          targetId: refundId,
          before: { status: RefundStatus.PENDING_MANUAL },
          after: { status: RefundStatus.PENDING_AUTO },
        },
        trx,
      );
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
