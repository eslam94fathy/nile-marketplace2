import { inject, injectable } from 'tsyringe';
import { type WorkerEnv } from '../../../lib/config';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type EventEnvelope,
  type IOutbox,
  OrderPlaced,
  PaymentFailed,
  PaymentPaid,
  PermanentEventError,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { addDuration, TimeUnit } from '../../../pkg/time';
import { ActorRole, OrderStatus, SellerOrderCancelReason, SellerOrderStatus } from '../enums';
import { type OrderRepository } from '../repository/order.repository';
import { type LockedOrder, type OrderLifecycleService } from './order-lifecycle.service';

const SYSTEM = { role: ActorRole.SYSTEM, userId: null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `ordering.payment-updates` consumer (spec 09 §3.11), inside the host's transaction: a Kashier
 * payment places the order (seller orders `placed` with their acceptance deadline, `order.placed`);
 * a failed one cancels it like an expiry. Only an order still `pending_payment` changes: a late
 * payment (SD-5) or a stale event is a logged no-op, payments has already flagged any refund.
 */
@injectable()
export class PaymentUpdateService {
  constructor(
    @inject(TOKENS.Env) private readonly env: Pick<WorkerEnv, 'SELLER_ACCEPT_TIMEOUT_HOURS'>,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.OrderRepository) private readonly orders: OrderRepository,
    @inject(TOKENS.OrderLifecycleService) private readonly lifecycle: OrderLifecycleService,
  ) {}

  async handle(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const orderId = envelope.payload.orderId;
    if (typeof orderId !== 'string' || !UUID.test(orderId)) {
      throw new PermanentEventError(`${envelope.eventType}: payload.orderId must be a UUID`);
    }
    if (envelope.eventType === PaymentPaid.type && envelope.payload.lateAfterExpiry === true) {
      this.logger.info('late payment: the order stays cancelled, payments flagged the refund', {
        event: 'PAYMENT_PAID_LATE_IGNORED',
        orderId,
      });
      return;
    }
    const locked = await this.lifecycle.lock(orderId, trx);
    if (!locked) throw new PermanentEventError(`${envelope.eventType}: order ${orderId} not found`);
    if (locked.order.status !== OrderStatus.PENDING_PAYMENT) {
      this.logger.warn('payment event ignored for the order state', {
        event: 'PAYMENT_EVENT_IGNORED',
        eventType: envelope.eventType,
        orderId,
        status: locked.order.status,
      });
      return;
    }
    if (envelope.eventType === PaymentPaid.type) await this.place(locked, trx);
    else if (envelope.eventType === PaymentFailed.type) await this.cancel(locked, trx);
    else throw new PermanentEventError(`ordering.payment-updates does not handle ${envelope.eventType}`);
  }

  /** `payment.paid`: every seller order `pending_payment → placed` with its deadline, then `order.placed`. */
  private async place(locked: LockedOrder, trx: DbTransaction): Promise<void> {
    const now = this.lifecycle.now();
    const acceptDeadlineAt = addDuration(now, this.env.SELLER_ACCEPT_TIMEOUT_HOURS, TimeUnit.HOUR);
    for (const sellerOrder of locked.sellerOrders) {
      await this.lifecycle.transition(
        locked,
        sellerOrder.id,
        [SellerOrderStatus.PENDING_PAYMENT],
        { status: SellerOrderStatus.PLACED, acceptDeadlineAt },
        SYSTEM,
        null,
        trx,
      );
    }
    const order = await this.lifecycle.settle(locked, SYSTEM, trx);
    await this.orders.setPlacedAt(order.id, now, trx);
    await this.outbox.add(trx, {
      contract: OrderPlaced,
      aggregateId: order.id,
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerId: order.customerId,
        paymentMethod: order.paymentMethod,
        sellerOrderIds: locked.sellerOrders.map((s) => s.id),
        itemsTotal: order.itemsTotal.toString(),
        deliveryFee: order.deliveryFee.toString(),
        total: order.total.toString(),
        placedAt: now.toISOString(),
      },
    });
    this.logger.info('order placed on payment', { event: 'ORDER_PLACED', orderId: order.id });
  }

  /** `payment.failed` (amount mismatch): cancelled like an expiry, with `payment_failed` (spec 09 §3.11). */
  private async cancel(locked: LockedOrder, trx: DbTransaction): Promise<void> {
    for (const sellerOrder of locked.sellerOrders) {
      await this.lifecycle.cancelSellerOrder(
        locked,
        sellerOrder.id,
        [SellerOrderStatus.PENDING_PAYMENT],
        { reason: SellerOrderCancelReason.PAYMENT_FAILED, note: null },
        SYSTEM,
        trx,
      );
    }
    await this.lifecycle.settle(locked, SYSTEM, trx);
    this.logger.info('order cancelled: payment failed', {
      event: 'ORDER_PAYMENT_FAILED',
      orderId: locked.order.id,
    });
  }
}
