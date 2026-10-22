import { setTimeout as sleep } from 'node:timers/promises';
import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, PaymentExpired } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { EGP, type Money } from '../../../lib/money';
import { type IPaymentGateway, PaymentGatewayError } from '../../../pkg/payments';
import { PaymentMethod, PaymentStatus, RefundStatus } from '../enums';
import { paymentProviderUnavailable } from '../errors';
import { type Payment, type PaymentSummary, toSummary } from '../model/payment.model';
import { type PaymentRefundRepository } from '../repository/payment-refund.repository';
import { type PaymentRepository } from '../repository/payment.repository';
import { type ReturnRefundStatus, type ReturnRefundView } from '../model/refund.model';
import { type PaymentSettlementService, type SettlementOutcome } from './payment-settlement.service';

/** A racing request may hold Kashier's session but not have stored it yet: one more look after this. */
const STORE_RACE_WAIT_MS = 300;

/** What `createKashierSession` gives ordering (spec 10 §2). */
export type KashierSessionResult =
  | { kind: 'session'; checkoutUrl: string; expiresAt: Date }
  /** Not a Kashier payment still `initiated` inside its window: ordering answers ORDER_NOT_AWAITING_PAYMENT. */
  | { kind: 'not_awaiting_payment' };

/** spec 10 PA-13; `unknown` = Kashier couldn't be asked (expire anyway, SD-5). */
export type ProviderStatus = 'paid' | 'pending' | 'unpaid' | 'unknown';

/** Public API of payments (spec 10 §2), injected into ordering. */
export interface IPaymentDirectory {
  /** Checkout, in its transaction: COD → `pending`, Kashier → `initiated`. Returns the payment id. */
  createForOrder(
    payment: { orderId: string; customerId: string; method: PaymentMethod; amount: Money },
    trx: DbTransaction,
  ): Promise<string>;
  /** Order views: one batched query; orders without a payment are left out. */
  getSummaries(orderIds: readonly string[], trx?: DbTransaction): Promise<PaymentSummary[]>;
  /**
   * The return views (spec 10 §8.5), batched: each return's refund (the latest when several), with its
   * status for the customer. Returns without a refund are left out.
   */
  getRefundsByReturnIds(returnIds: readonly string[]): Promise<Map<string, ReturnRefundView>>;
  /**
   * Outside any transaction. The stored session while it is valid, else a new one ending at
   * `expiresAt` (PA-3, PA-12). Throws PAYMENT_PROVIDER_UNAVAILABLE when Kashier can't give one.
   */
  createKashierSession(
    orderId: string,
    session: { expiresAt: Date; description: string },
  ): Promise<KashierSessionResult>;
  /** Outside any transaction (the expiry job): Kashier's view of the payment (PA-13). */
  fetchProviderStatus(orderId: string): Promise<ProviderStatus>;
  /** Kashier reports the session paid but no webhook was applied yet: same effect as one (UC-PA-2). */
  markPaidFromProvider(orderId: string): Promise<SettlementOutcome>;
  /**
   * The expiry job, in its transaction after it locked the order (OR-3): conditional `initiated →
   * expired` with `payment.expired`. false = the payment had moved on (the webhook won).
   */
  expire(orderId: string, trx: DbTransaction): Promise<boolean>;
}

/** How a return view names a refund's state (spec 10 §8.5). */
const RETURN_REFUND_STATUS: Readonly<Record<RefundStatus, ReturnRefundStatus>> = {
  [RefundStatus.PENDING_AUTO]: 'pending',
  [RefundStatus.PROCESSING]: 'processing',
  [RefundStatus.SUCCEEDED]: 'succeeded',
  [RefundStatus.RECORDED]: 'succeeded',
  [RefundStatus.PENDING_MANUAL]: 'manual',
};

@injectable()
export class PaymentDirectory implements IPaymentDirectory {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.PaymentGateway) private readonly gateway: IPaymentGateway,
    @inject(TOKENS.PaymentRepository) private readonly payments: PaymentRepository,
    @inject(TOKENS.PaymentRefundRepository) private readonly refunds: PaymentRefundRepository,
    @inject(TOKENS.PaymentSettlementService) private readonly settlement: PaymentSettlementService,
  ) {}

  createForOrder(
    payment: { orderId: string; customerId: string; method: PaymentMethod; amount: Money },
    trx: DbTransaction,
  ): Promise<string> {
    const status = payment.method === PaymentMethod.COD ? PaymentStatus.PENDING : PaymentStatus.INITIATED;
    return this.payments.insert({ ...payment, status }, trx);
  }

  async getRefundsByReturnIds(returnIds: readonly string[]): Promise<Map<string, ReturnRefundView>> {
    const refunds = await this.refunds.findByReturnIds(returnIds);
    // Oldest first, so the latest refund of a return is the one kept.
    return new Map(
      refunds.flatMap((refund) =>
        refund.returnId === null
          ? []
          : [
              [
                refund.returnId,
                {
                  status: RETURN_REFUND_STATUS[refund.status],
                  amount: refund.amount,
                  refundedAt: refund.succeededAt ?? refund.recordedAt,
                },
              ] as const,
            ],
      ),
    );
  }

  async getSummaries(orderIds: readonly string[], trx?: DbTransaction): Promise<PaymentSummary[]> {
    return (await this.payments.findByOrderIds(orderIds, trx)).map(toSummary);
  }

  async createKashierSession(
    orderId: string,
    session: { expiresAt: Date; description: string },
  ): Promise<KashierSessionResult> {
    const payment = await this.payments.findByOrderId(orderId);
    if (!payment || payment.method !== PaymentMethod.KASHIER || payment.status !== PaymentStatus.INITIATED) {
      return { kind: 'not_awaiting_payment' };
    }
    if (payment.session) return this.stored(payment);

    try {
      const created = await this.gateway.createSession({
        merchantOrderId: payment.id,
        amount: payment.amount.toString(),
        currency: EGP,
        expiresAt: session.expiresAt,
        customerReference: orderId,
        description: session.description,
      });
      const kept = await this.payments.storeSession(payment.id, {
        id: created.sessionId,
        url: created.checkoutUrl,
        expiresAt: created.expiresAt,
      });
      if (kept) return { kind: 'session', checkoutUrl: created.checkoutUrl, expiresAt: created.expiresAt };
      // The payment moved on (paid or expired) while we asked Kashier.
      return this.reread(payment.id, orderId);
    } catch (error) {
      if (!(error instanceof PaymentGatewayError)) throw error;
      if (error.kind === 'session_exists') return this.reread(payment.id, orderId, error);
      this.logger.warn('kashier session could not be created', {
        event: 'KASHIER_SESSION_FAILED',
        orderId,
        paymentId: payment.id,
        kind: error.kind,
        status: error.status,
        error,
      });
      throw paymentProviderUnavailable(error);
    }
  }

  async fetchProviderStatus(orderId: string): Promise<ProviderStatus> {
    const payment = await this.payments.findByOrderId(orderId);
    if (!payment) return 'unknown';
    if (payment.status === PaymentStatus.PAID) return 'paid';
    if (!payment.session) return 'unpaid';
    try {
      return (await this.gateway.getSessionStatus(payment.session.id)).status;
    } catch (error) {
      this.logger.warn('kashier session status unavailable', {
        event: 'KASHIER_STATUS_UNAVAILABLE',
        orderId,
        paymentId: payment.id,
        error,
      });
      return 'unknown';
    }
  }

  markPaidFromProvider(orderId: string): Promise<SettlementOutcome> {
    return this.tx.run(async (trx) => {
      const payment = await this.payments.lockByOrderId(orderId, trx);
      if (!payment) throw new Error(`order ${orderId} has no payment`);
      // A session is created for the payment's exact amount, so a PAID session took that amount.
      return this.settlement.applySuccess(
        payment,
        { transactionRef: null, amount: payment.amount, paidAt: this.clock.now() },
        trx,
      );
    });
  }

  async expire(orderId: string, trx: DbTransaction): Promise<boolean> {
    const payment = await this.payments.lockByOrderId(orderId, trx);
    if (!payment) return false;
    const expired = await this.payments.transition(
      payment.id,
      [PaymentStatus.INITIATED],
      PaymentStatus.EXPIRED,
      trx,
    );
    if (expired) {
      await this.outbox.add(trx, {
        contract: PaymentExpired,
        aggregateId: payment.id,
        payload: { paymentId: payment.id, orderId, expiredAt: this.clock.now().toISOString() },
      });
    }
    return expired;
  }

  private stored(payment: Payment): KashierSessionResult {
    if (!payment.session || payment.session.expiresAt <= this.clock.now())
      return { kind: 'not_awaiting_payment' };
    return { kind: 'session', checkoutUrl: payment.session.url, expiresAt: payment.session.expiresAt };
  }

  /**
   * After a lost race or Kashier's "another session is opened" (PA-12): the stored session if there is
   * one. Kashier holding a session we never stored means our first call timed out after it was
   * created: nothing to hand out (KASHIER_SESSION_LOST); the order expires as usual.
   */
  private async reread(paymentId: string, orderId: string, cause?: unknown): Promise<KashierSessionResult> {
    let current = await this.payments.findById(paymentId);
    if (!current?.session && cause !== undefined) {
      await sleep(STORE_RACE_WAIT_MS);
      current = await this.payments.findById(paymentId);
    }
    if (current?.session) return this.stored(current);
    if (current?.status !== PaymentStatus.INITIATED) return { kind: 'not_awaiting_payment' };
    this.logger.error('kashier holds a session this payment never stored', {
      event: 'KASHIER_SESSION_LOST',
      orderId,
      paymentId,
    });
    throw paymentProviderUnavailable(cause);
  }
}
