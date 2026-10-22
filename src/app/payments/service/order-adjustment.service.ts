import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type EventEnvelope,
  OrderClosed,
  PermanentEventError,
  ReturnCompleted,
  SellerOrderCancelled,
  SellerOrderDelivered,
  SellerOrderItemsCancelled,
  SellerOrderReturned,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { Money } from '../../../lib/money';
import { PaymentMethod, PaymentStatus, RefundReason } from '../enums';
import { isOpenCod, isRefundableKashier, type Payment } from '../model/payment.model';
import { type PaymentRefundRepository } from '../repository/payment-refund.repository';
import { type PaymentRepository } from '../repository/payment.repository';

/**
 * The `payments.order-adjustments` consumer (spec 10 UC-PA-3, UC-PA-5), inside the host's transaction
 * (architecture §3.2). Kashier: a refund row per cancelled or returned amount, only once money was
 * taken. COD: the amount still to collect shrinks, collections add up, and the close step settles it;
 * a completed return owes the customer a refund paid by an admin.
 * Every handler locks the payment row first, and payments is last in the lock order (spec 10 PA-2).
 */
@injectable()
export class OrderAdjustmentService {
  constructor(
    @inject(TOKENS.PaymentRepository) private readonly payments: PaymentRepository,
    @inject(TOKENS.PaymentRefundRepository) private readonly refunds: PaymentRefundRepository,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async handle(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const orderId = uuidField(envelope, 'orderId');
    switch (envelope.eventType) {
      case SellerOrderItemsCancelled.type:
        return this.reduce(
          envelope,
          orderId,
          moneyField(envelope, 'amountCancelled'),
          RefundReason.ITEMS_CANCELLED,
          trx,
        );
      case SellerOrderCancelled.type:
        return this.reduce(
          envelope,
          orderId,
          moneyField(envelope, 'amountCancelled'),
          RefundReason.SELLER_ORDER_CANCELLED,
          trx,
        );
      case SellerOrderReturned.type:
        return this.reduce(
          envelope,
          orderId,
          moneyField(envelope, 'subtotal'),
          RefundReason.DELIVERY_FAILED,
          trx,
        );
      case SellerOrderDelivered.type:
        return this.collect(envelope, orderId, trx);
      case OrderClosed.type:
        return this.close(envelope, orderId, trx);
      case ReturnCompleted.type:
        return this.returned(envelope, orderId, trx);
      default:
        throw new PermanentEventError(`payments.order-adjustments does not handle ${envelope.eventType}`);
    }
  }

  /** A seller order (or part of it) won't be delivered: refund it (Kashier) or stop expecting it (COD). */
  private async reduce(
    envelope: EventEnvelope,
    orderId: string,
    amount: Money,
    reason: RefundReason,
    trx: DbTransaction,
  ): Promise<void> {
    const payment = await this.lock(orderId, trx);
    const sellerOrderId = uuidField(envelope, 'sellerOrderId');
    if (isRefundableKashier(payment)) {
      await this.flagRefund(payment, sellerOrderId, amount, reason, trx);
      return;
    }
    if (isOpenCod(payment)) {
      const remaining = payment.amount.minus(amount);
      if (remaining.isNegative()) {
        throw new PermanentEventError(
          `COD payment ${payment.id} would go below 0 (${payment.amount.toString()} - ${amount.toString()})`,
        );
      }
      await this.payments.updateAmounts(payment.id, { ...payment, amount: remaining }, trx);
      return;
    }
    this.skip(envelope, payment);
  }

  /** COD: the agent took cash at the door (spec 10 UC-PA-3). Kashier deliveries move no money here. */
  private async collect(envelope: EventEnvelope, orderId: string, trx: DbTransaction): Promise<void> {
    const payment = await this.lock(orderId, trx);
    if (!isOpenCod(payment)) {
      this.skip(envelope, payment);
      return;
    }
    const collected = envelope.payload.codCollectedAmount;
    if (typeof collected !== 'string') {
      throw new PermanentEventError(
        `${envelope.eventType}: payload.codCollectedAmount is required for a COD order`,
      );
    }
    await this.payments.updateAmounts(
      payment.id,
      {
        status: PaymentStatus.PARTIALLY_COLLECTED,
        amount: payment.amount,
        collectedAmount: payment.collectedAmount.plus(moneyField(envelope, 'codCollectedAmount')),
      },
      trx,
    );
  }

  /**
   * UC-PA-5 `return.completed`: a refund row for what the return gives back. Kashier refunds are done
   * by hand until the refund job (PA-31); a COD refund carries the sealed payout details (RE-8). Both
   * stay within what was collected (PA-20).
   */
  private async returned(envelope: EventEnvelope, orderId: string, trx: DbTransaction): Promise<void> {
    const refundAmount = moneyField(envelope, 'refundAmount');
    if (!refundAmount.greaterThan(Money.zero())) return;
    const payment = await this.lock(orderId, trx);
    const returnId = uuidField(envelope, 'returnId');
    const sellerOrderId = uuidField(envelope, 'sellerOrderId');
    const cod = payment.method === PaymentMethod.COD;
    if (!cod && !isRefundableKashier(payment)) {
      // A delivered Kashier order was paid; anything else is a defect worth looking at.
      this.logger.error('return completed on a payment that took no money', {
        event: 'RETURN_REFUND_UNPAYABLE',
        paymentId: payment.id,
        returnId,
        status: payment.status,
      });
      return;
    }
    const sealed = envelope.payload.refundPayoutEncrypted;
    if (cod && typeof sealed !== 'string') {
      throw new PermanentEventError(
        `${envelope.eventType}: payload.refundPayoutEncrypted is required for a COD return`,
      );
    }
    await this.flagRefund(payment, sellerOrderId, refundAmount, RefundReason.RETURN, trx, {
      returnId,
      payoutDetailsEncrypted: cod ? (sealed as string) : null,
    });
  }

  /** Every seller order is terminal (spec 10 UC-PA-3 `order.closed`). */
  private async close(envelope: EventEnvelope, orderId: string, trx: DbTransaction): Promise<void> {
    const payment = await this.lock(orderId, trx);
    const deliveryFee = moneyField(envelope, 'deliveryFee');
    const originalDeliveryFee = moneyField(envelope, 'originalDeliveryFee');

    if (isRefundableKashier(payment)) {
      // Nothing was delivered: the fee is refunded too (Q-28).
      if (deliveryFee.isZero() && originalDeliveryFee.greaterThan(Money.zero())) {
        await this.flagRefund(payment, null, originalDeliveryFee, RefundReason.ALL_CANCELLED_FEE, trx);
      }
      return;
    }
    if (!isOpenCod(payment)) {
      this.skip(envelope, payment);
      return;
    }

    const deliveredItemsTotal = moneyField(envelope, 'deliveredItemsTotal');
    const expected = deliveredItemsTotal.plus(deliveryFee);
    const fields = {
      paymentId: payment.id,
      orderId,
      expected: expected.toString(),
      collected: payment.collectedAmount.toString(),
    };
    if (payment.collectedAmount.equals(expected)) {
      this.logger.info('COD payment settled', { event: 'COD_SETTLED', ...fields });
    } else if (payment.collectedAmount.equals(deliveredItemsTotal)) {
      // S-3: the fee carrier never collected it; flagged, not an error.
      this.logger.warn('COD delivery fee was never collected', {
        event: 'COD_DELIVERY_FEE_UNCOLLECTED',
        ...fields,
      });
    } else {
      // Investigated by hand (spec 10 UC-PA-3); the payment still settles on what was collected.
      this.logger.error('COD collected amount does not match the delivered order', {
        event: 'COD_AMOUNT_MISMATCH',
        ...fields,
      });
    }
    await this.payments.updateAmounts(
      payment.id,
      {
        status: payment.collectedAmount.isZero() ? PaymentStatus.CANCELLED : PaymentStatus.COLLECTED,
        amount: payment.collectedAmount,
        collectedAmount: payment.collectedAmount,
      },
      trx,
    );
  }

  /**
   * Flags a refund due, never beyond what was collected (PA-20): the refunds already flagged on the
   * payment (pending or recorded) count first. A late payment's full refund (SD-5) and the refunds
   * of the cancellation events of the same order can arrive in either order; this keeps their sum at
   * most the money taken.
   */
  private async flagRefund(
    payment: Payment,
    sellerOrderId: string | null,
    amount: Money,
    reason: RefundReason,
    trx: DbTransaction,
    extra: { returnId: string; payoutDetailsEncrypted: string | null } | null = null,
  ): Promise<void> {
    const room = payment.collectedAmount.minus(await this.refunds.sumForPayment(payment.id, trx));
    const refund = amount.greaterThan(room) ? room : amount;
    const fields = {
      paymentId: payment.id,
      orderId: payment.orderId,
      sellerOrderId,
      reason,
      amount: amount.toString(),
    };
    if (!refund.greaterThan(Money.zero())) {
      // Includes a seller order whose lines were all cancelled before (it reports 0).
      this.logger.info('no refund left to flag', { event: 'REFUND_ALREADY_COVERED', ...fields });
      return;
    }
    if (!refund.equals(amount)) {
      this.logger.warn('refund capped at what is left of the payment', {
        event: 'REFUND_CAPPED',
        ...fields,
        flagged: refund.toString(),
      });
    }
    await this.refunds.insertPending(
      {
        paymentId: payment.id,
        sellerOrderId,
        amount: refund,
        reason,
        ...(extra ? { returnId: extra.returnId, payoutDetailsEncrypted: extra.payoutDetailsEncrypted } : {}),
      },
      trx,
    );
    this.logger.info('refund due recorded', { event: 'REFUND_DUE', ...fields, flagged: refund.toString() });
  }

  /** Every checkout creates its payment in the same transaction, so a missing one can't be retried away. */
  private async lock(orderId: string, trx: DbTransaction): Promise<Payment> {
    const payment = await this.payments.lockByOrderId(orderId, trx);
    if (!payment) throw new PermanentEventError(`order ${orderId} has no payment`);
    return payment;
  }

  /** A Kashier payment that was never paid, or a COD payment already settled: nothing to change. */
  private skip(envelope: EventEnvelope, payment: Payment): void {
    this.logger.debug('order event leaves the payment unchanged', {
      eventType: envelope.eventType,
      paymentId: payment.id,
      method: payment.method,
      status: payment.status,
    });
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A payload that can never be processed goes straight to the DLQ (retries can't fix it). */
function uuidField(envelope: EventEnvelope, field: string): string {
  const value = envelope.payload[field];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new PermanentEventError(`${envelope.eventType}: payload.${field} must be a UUID`);
  }
  return value;
}

function moneyField(envelope: EventEnvelope, field: string): Money {
  const value = envelope.payload[field];
  try {
    if (typeof value !== 'string') throw new RangeError('not a string');
    const money = Money.of(value);
    if (money.isNegative()) throw new RangeError('negative');
    return money;
  } catch {
    throw new PermanentEventError(
      `${envelope.eventType}: payload.${field} must be a non-negative money string`,
    );
  }
}
