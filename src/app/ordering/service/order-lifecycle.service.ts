import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, OrderClosed, SellerOrderCancelled } from '../../../lib/events';
import { Money } from '../../../lib/money';
import { type IInventoryService } from '../../inventory';
import { type ICouponRedemptions } from '../../promotions';
import { type ActorRole, OrderStatus, type SellerOrderCancelReason, SellerOrderStatus } from '../enums';
import { deriveOrderStatus, isBilled, isClosed } from '../model/order-status.model';
import {
  type Order,
  type OrderItem,
  openQuantity,
  paidSubtotal,
  type SellerOrder,
} from '../model/order.model';
import { type OrderItemRepository } from '../repository/order-item.repository';
import { type OrderRepository } from '../repository/order.repository';
import {
  type SellerOrderRepository,
  type SellerOrderTransition,
} from '../repository/seller-order.repository';
import { type StatusHistoryRepository } from '../repository/status-history.repository';

export interface Actor {
  role: ActorRole;
  /** null = system */
  userId: string | null;
}

/** An order and its seller orders, all locked in the caller's transaction (spec 09 §1.2). */
export interface LockedOrder {
  order: Order;
  sellerOrders: SellerOrder[];
}

/**
 * The shared write path of every seller-order change after checkout (spec 09 §1.1–§1.2, §3.9):
 * lock the order and its seller orders, apply a conditional transition with its history row, then
 * re-derive the stored order status and close the order when every seller order is terminal. Used by
 * the HTTP actions, the jobs and (from step 7) the shipment consumer.
 */
@injectable()
export class OrderLifecycleService {
  constructor(
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.InventoryService) private readonly inventory: IInventoryService,
    @inject(TOKENS.CouponRedemptions) private readonly coupons: ICouponRedemptions,
    @inject(TOKENS.OrderRepository) private readonly orders: OrderRepository,
    @inject(TOKENS.SellerOrderRepository) private readonly sellerOrders: SellerOrderRepository,
    @inject(TOKENS.OrderItemRepository) private readonly items: OrderItemRepository,
    @inject(TOKENS.StatusHistoryRepository) private readonly history: StatusHistoryRepository,
  ) {}

  now(): Date {
    return this.clock.now();
  }

  /** Locks the order, then its seller orders by id (OR-3). null = no such order, or busy with `skipLocked`. */
  async lock(
    orderId: string,
    trx: DbTransaction,
    options: { skipLocked?: boolean } = {},
  ): Promise<LockedOrder | null> {
    const order = await this.orders.lock(orderId, trx, options);
    if (!order) return null;
    return { order, sellerOrders: await this.sellerOrders.lockByOrderId(orderId, trx) };
  }

  /**
   * Moves a seller order on if its status is still one of `from`, writes its history row and keeps
   * `locked` current. Returns the updated seller order, or null when the transition doesn't apply.
   */
  async transition(
    locked: LockedOrder,
    sellerOrderId: string,
    from: readonly SellerOrderStatus[],
    change: SellerOrderTransition,
    actor: Actor,
    reason: string | null,
    trx: DbTransaction,
  ): Promise<SellerOrder | null> {
    const before = locked.sellerOrders.find((s) => s.id === sellerOrderId);
    if (!before) return null;
    const after = await this.sellerOrders.transition(sellerOrderId, from, change, trx);
    if (!after) return null;
    await this.history.addSellerOrderEntries(
      [
        {
          subjectId: after.id,
          fromStatus: before.status,
          toStatus: after.status,
          actorRole: actor.role,
          actorUserId: actor.userId,
          reason,
        },
      ],
      trx,
    );
    locked.sellerOrders = locked.sellerOrders.map((s) => (s.id === after.id ? after : s));
    return after;
  }

  /**
   * Whole seller-order cancellation (UC-OR-2, UC-OR-4, timeout, payment expiry / failure): releases
   * every open unit and publishes `seller_order.cancelled`. `amountCancelled` defaults to the current
   * paid subtotal (after its coupon share, spec 09 §8.8); a partial cancellation that empties the seller
   * order passes the paid subtotal before it (OR-12).
   */
  async cancelSellerOrder(
    locked: LockedOrder,
    sellerOrderId: string,
    from: readonly SellerOrderStatus[],
    cancel: { reason: SellerOrderCancelReason; note: string | null; amountCancelled?: Money },
    actor: Actor,
    trx: DbTransaction,
  ): Promise<SellerOrder | null> {
    const previous = locked.sellerOrders.find((s) => s.id === sellerOrderId);
    const at = this.clock.now();
    const cancelled = await this.transition(
      locked,
      sellerOrderId,
      from,
      { status: SellerOrderStatus.CANCELLED, cancel: { reason: cancel.reason, byUserId: actor.userId, at } },
      actor,
      cancel.note,
      trx,
    );
    if (!cancelled || !previous) return null;

    await this.releaseOpenUnits(await this.items.findBySellerOrderIds([cancelled.id], trx), trx);
    await this.outbox.add(trx, {
      contract: SellerOrderCancelled,
      aggregateId: cancelled.id,
      payload: {
        sellerOrderId: cancelled.id,
        orderId: locked.order.id,
        sellerId: cancelled.sellerId,
        paymentMethod: locked.order.paymentMethod,
        previousStatus: previous.status,
        reason: cancel.reason,
        amountCancelled: (cancel.amountCancelled ?? paidSubtotal(cancelled)).toString(),
        cancelledAt: at.toISOString(),
      },
    });
    return cancelled;
  }

  /** Returns every still-reserved unit of these lines to stock (spec 07 UC-IN-2). */
  async releaseOpenUnits(items: readonly OrderItem[], trx: DbTransaction): Promise<void> {
    const lines = items
      .filter((item) => openQuantity(item) > 0)
      .map((item) => ({ orderItemId: item.id, quantity: openQuantity(item) }));
    if (lines.length > 0) await this.inventory.release(lines, trx);
  }

  /**
   * Re-derives and stores the order after its seller orders changed (spec 09 §1.1): the paid items total
   * and the discount of the seller orders still billed (OR-13, §8.8), status, history row on a change, and
   * the close step (§3.9) the first time every seller order is terminal. An order that closes `cancelled`
   * gives its coupon use back, still the last lock (spec 19 UC-PR-3, R-18).
   */
  async settle(locked: LockedOrder, actor: Actor, trx: DbTransaction): Promise<Order> {
    const { order, sellerOrders } = locked;
    const status = deriveOrderStatus(sellerOrders.map((s) => s.status));
    const billed = sellerOrders.filter((s) => isBilled(s.status));
    const itemsTotal = Money.sum(billed.map(paidSubtotal));
    const discountTotal = Money.sum(billed.map((s) => s.discountAmount));
    const closing = isClosed(status) && !isClosed(order.status);
    const delivered = sellerOrders.filter((s) => s.status === SellerOrderStatus.DELIVERED);
    // Q-28: nothing delivered → no delivery fee.
    const deliveryFee = closing && delivered.length === 0 ? Money.zero() : order.deliveryFee;
    const now = this.clock.now();

    const updated: Order = {
      ...order,
      status,
      itemsTotal,
      discountTotal,
      deliveryFee,
      total: itemsTotal.plus(deliveryFee),
      completedAt: closing && status !== OrderStatus.CANCELLED ? now : order.completedAt,
      cancelledAt: closing && status === OrderStatus.CANCELLED ? now : order.cancelledAt,
    };
    await this.orders.updateState(order.id, updated, trx);
    if (status !== order.status) {
      await this.history.addOrderEntries(
        [
          {
            subjectId: order.id,
            fromStatus: order.status,
            toStatus: status,
            actorRole: actor.role,
            actorUserId: actor.userId,
            reason: null,
          },
        ],
        trx,
      );
    }
    if (closing && isClosed(status)) {
      await this.outbox.add(trx, {
        contract: OrderClosed,
        aggregateId: order.id,
        payload: {
          orderId: order.id,
          customerId: order.customerId,
          paymentMethod: order.paymentMethod,
          finalStatus: status,
          deliveredItemsTotal: Money.sum(delivered.map(paidSubtotal)).toString(),
          deliveryFee: deliveryFee.toString(),
          originalDeliveryFee: order.deliveryFee.toString(),
          closedAt: now.toISOString(),
        },
      });
      if (status === OrderStatus.CANCELLED) await this.coupons.release(order.id, trx);
    }
    locked.order = updated;
    return updated;
  }
}
