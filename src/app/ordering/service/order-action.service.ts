import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type IOutbox,
  SellerOrderAccepted,
  SellerOrderItemsCancelled,
  SellerOrderReadyForPickup,
  SellerOrderReturned,
} from '../../../lib/events';
import { Money } from '../../../lib/money';
import { type IInventoryService } from '../../inventory';
import { PaymentMethod } from '../../payments';
import { type ISellerDirectory } from '../../sellers';
import { ActorRole, type ItemCancelReason, SellerOrderCancelReason, SellerOrderStatus } from '../enums';
import {
  itemCancelQuantityInvalid,
  orderItemNotFound,
  orderNotFound,
  sellerOrderInvalidStatusTransition,
  sellerOrderNotCancellable,
  sellerOrderNotFound,
} from '../errors';
import { openQuantity, type SellerOrder } from '../model/order.model';
import { type OrderItemCancellationRepository } from '../repository/order-item-cancellation.repository';
import { type OrderItemRepository } from '../repository/order-item.repository';
import { type SellerOrderRepository } from '../repository/seller-order.repository';
import { type Actor, type LockedOrder, type OrderLifecycleService } from './order-lifecycle.service';

const S = SellerOrderStatus;
/** Q-31: a seller may cancel (whole or items) until the parcel is picked up. */
const SELLER_CANCELLABLE: readonly SellerOrderStatus[] = [S.PLACED, S.ACCEPTED, S.READY_FOR_PICKUP];
/** Q-31: a customer only while the seller hasn't accepted. */
const CUSTOMER_CANCELLABLE: readonly SellerOrderStatus[] = [S.PLACED];

export interface ItemCancellation {
  quantity: number;
  reason: ItemCancelReason;
  note: string | null;
}

/**
 * Customer and seller actions on seller orders (spec 09 UC-OR-2…5, UC-OR-7). Each runs in one
 * transaction that starts by locking the order and its seller orders (OR-3), re-checks the status
 * under that lock, and ends by re-deriving the order (§1.1).
 */
@injectable()
export class OrderActionService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.InventoryService) private readonly inventory: IInventoryService,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.SellerOrderRepository) private readonly sellerOrders: SellerOrderRepository,
    @inject(TOKENS.OrderItemRepository) private readonly items: OrderItemRepository,
    @inject(TOKENS.OrderItemCancellationRepository)
    private readonly cancellations: OrderItemCancellationRepository,
    @inject(TOKENS.OrderLifecycleService) private readonly lifecycle: OrderLifecycleService,
  ) {}

  /** UC-OR-2: the whole seller order, only while placed. */
  async customerCancel(
    customer: { customerId: string; userId: string },
    orderId: string,
    sellerOrderId: string,
    note: string | null,
  ): Promise<void> {
    await this.tx.run(async (trx) => {
      const locked = await this.lifecycle.lock(orderId, trx);
      if (!locked || locked.order.customerId !== customer.customerId) throw orderNotFound();
      const target = sellerOrderIn(locked, sellerOrderId);
      if (!CUSTOMER_CANCELLABLE.includes(target.status)) throw sellerOrderNotCancellable(target.status);
      const actor = { role: ActorRole.CUSTOMER, userId: customer.userId };
      await this.lifecycle.cancelSellerOrder(
        locked,
        target.id,
        CUSTOMER_CANCELLABLE,
        { reason: SellerOrderCancelReason.CUSTOMER_CANCELLED, note },
        actor,
        trx,
      );
      await this.lifecycle.settle(locked, actor, trx);
    });
  }

  /**
   * UC-OR-3: placed → accepted, published as `seller_order.accepted` (spec 09 §8.2). Allowed after the
   * deadline until the timeout job has run.
   */
  accept(seller: SellerCaller, sellerOrderId: string): Promise<void> {
    return this.asSeller(seller, sellerOrderId, async (locked, target, actor, trx) => {
      const now = this.lifecycle.now();
      const done = await this.lifecycle.transition(
        locked,
        target.id,
        [S.PLACED],
        { status: S.ACCEPTED, acceptedAt: now },
        actor,
        null,
        trx,
      );
      if (!done) throw sellerOrderInvalidStatusTransition(target.status);
      await this.outbox.add(trx, {
        contract: SellerOrderAccepted,
        aggregateId: done.id,
        payload: {
          sellerOrderId: done.id,
          orderId: locked.order.id,
          orderNumber: locked.order.orderNumber,
          sellerId: done.sellerId,
          customerId: locked.order.customerId,
          acceptedAt: now.toISOString(),
        },
      });
    });
  }

  /** UC-OR-3: accepted → ready_for_pickup, with the snapshot delivery builds the shipment from. */
  ready(seller: SellerCaller, sellerOrderId: string): Promise<void> {
    return this.asSeller(seller, sellerOrderId, async (locked, target, actor, trx) => {
      const readyAt = this.lifecycle.now();
      const done = await this.lifecycle.transition(
        locked,
        target.id,
        [S.ACCEPTED],
        { status: S.READY_FOR_PICKUP, readyAt },
        actor,
        null,
        trx,
      );
      if (!done) throw sellerOrderInvalidStatusTransition(target.status);
      await this.publishReady(locked, done, readyAt, trx);
    });
  }

  /** UC-OR-4: the whole seller order, until picked up. */
  sellerCancel(seller: SellerCaller, sellerOrderId: string, note: string | null): Promise<void> {
    return this.asSeller(seller, sellerOrderId, async (locked, target, actor, trx) => {
      if (!SELLER_CANCELLABLE.includes(target.status)) throw sellerOrderNotCancellable(target.status);
      await this.lifecycle.cancelSellerOrder(
        locked,
        target.id,
        SELLER_CANCELLABLE,
        { reason: SellerOrderCancelReason.SELLER_CANCELLED, note },
        actor,
        trx,
      );
    });
  }

  /**
   * UC-OR-5: cancels quantities of one line, releases them and recomputes the money. When every line
   * is then fully cancelled the seller order becomes cancelled and only `seller_order.cancelled` is
   * published, with the subtotal before this cancellation as `amountCancelled` (OR-12).
   */
  cancelItems(
    seller: SellerCaller,
    sellerOrderId: string,
    itemId: string,
    cancellation: ItemCancellation,
  ): Promise<void> {
    return this.asSeller(seller, sellerOrderId, async (locked, target, actor, trx) => {
      if (!SELLER_CANCELLABLE.includes(target.status)) throw sellerOrderNotCancellable(target.status);
      const lines = await this.items.findBySellerOrderIds([target.id], trx);
      const line = lines.find((item) => item.id === itemId);
      if (!line) throw orderItemNotFound();
      if (cancellation.quantity > openQuantity(line)) throw itemCancelQuantityInvalid(openQuantity(line));

      const cancelledQuantity = line.cancelledQuantity + cancellation.quantity;
      const lineTotal = line.unitPrice.timesQuantity(line.quantity - cancelledQuantity);
      await this.items.setCancelledQuantity(line.id, cancelledQuantity, lineTotal, trx);
      await this.cancellations.insert(
        { orderItemId: line.id, ...cancellation, actorUserId: seller.userId },
        trx,
      );
      await this.inventory.release([{ orderItemId: line.id, quantity: cancellation.quantity }], trx);

      const after = lines.map((item) =>
        item.id === line.id ? { ...item, cancelledQuantity, lineTotal } : item,
      );
      const subtotal = Money.sum(after.map((item) => item.lineTotal));
      const commission = subtotal.timesRate(target.commissionRate);
      const sellerNet = subtotal.minus(commission);
      await this.sellerOrders.updateMoney(target.id, { subtotal, commission, sellerNet }, trx);
      locked.sellerOrders = locked.sellerOrders.map((s) =>
        s.id === target.id ? { ...s, subtotal, commission, sellerNet } : s,
      );

      if (after.every((item) => openQuantity(item) === 0)) {
        await this.lifecycle.cancelSellerOrder(
          locked,
          target.id,
          SELLER_CANCELLABLE,
          {
            reason: SellerOrderCancelReason.SELLER_CANCELLED,
            note: cancellation.note,
            amountCancelled: target.subtotal,
          },
          actor,
          trx,
        );
        return;
      }
      const amount = line.unitPrice.timesQuantity(cancellation.quantity);
      await this.outbox.add(trx, {
        contract: SellerOrderItemsCancelled,
        aggregateId: target.id,
        payload: {
          sellerOrderId: target.id,
          orderId: locked.order.id,
          sellerId: target.sellerId,
          paymentMethod: locked.order.paymentMethod,
          previousStatus: target.status,
          lines: [
            {
              orderItemId: line.id,
              variantId: line.variantId,
              quantity: cancellation.quantity,
              amount: amount.toString(),
            },
          ],
          amountCancelled: amount.toString(),
          newSubtotal: subtotal.toString(),
          newCommission: commission.toString(),
          newSellerNet: sellerNet.toString(),
          reason: cancellation.reason,
        },
      });
    });
  }

  /** UC-OR-7: the parcel is back; its units return to stock (Q-33). */
  returnReceived(seller: SellerCaller, sellerOrderId: string): Promise<void> {
    return this.asSeller(seller, sellerOrderId, async (locked, target, actor, trx) => {
      const returnedAt = this.lifecycle.now();
      const done = await this.lifecycle.transition(
        locked,
        target.id,
        [S.RETURNING_TO_SELLER],
        { status: S.RETURNED_TO_SELLER, returnedAt },
        actor,
        null,
        trx,
      );
      if (!done) throw sellerOrderInvalidStatusTransition(target.status);
      await this.lifecycle.releaseOpenUnits(await this.items.findBySellerOrderIds([done.id], trx), trx);
      await this.outbox.add(trx, {
        contract: SellerOrderReturned,
        aggregateId: done.id,
        payload: {
          sellerOrderId: done.id,
          orderId: locked.order.id,
          sellerId: done.sellerId,
          paymentMethod: locked.order.paymentMethod,
          subtotal: done.subtotal.toString(),
          returnedAt: returnedAt.toISOString(),
        },
      });
    });
  }

  /**
   * Resolves the caller's seller order (SELLER_ORDER_NOT_FOUND for another seller's or one still
   * awaiting payment), then runs `work` under the order lock on the re-read seller order, and
   * re-derives the order.
   */
  private async asSeller(
    seller: SellerCaller,
    sellerOrderId: string,
    work: (locked: LockedOrder, target: SellerOrder, actor: Actor, trx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    const found = await this.sellerOrders.findForSeller(sellerOrderId, seller.sellerId);
    if (!found) throw sellerOrderNotFound();
    await this.tx.run(async (trx) => {
      const locked = await this.lifecycle.lock(found.orderId, trx);
      if (!locked) throw sellerOrderNotFound();
      const actor = { role: ActorRole.SELLER, userId: seller.userId };
      await work(locked, sellerOrderIn(locked, sellerOrderId), actor, trx);
      await this.lifecycle.settle(locked, actor, trx);
    });
  }

  private async publishReady(
    locked: LockedOrder,
    sellerOrder: SellerOrder,
    readyAt: Date,
    trx: DbTransaction,
  ) {
    const { order } = locked;
    const [summary] = await this.sellers.getSummaries([sellerOrder.sellerId]);
    if (!summary) throw new Error(`seller ${sellerOrder.sellerId} has no summary`);
    const cod = order.paymentMethod === PaymentMethod.COD;
    await this.outbox.add(trx, {
      contract: SellerOrderReadyForPickup,
      aggregateId: sellerOrder.id,
      payload: {
        sellerOrderId: sellerOrder.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        sellerId: sellerOrder.sellerId,
        paymentMethod: order.paymentMethod,
        codItemsAmount: (cod ? sellerOrder.subtotal : Money.zero()).toString(),
        orderDeliveryFee: (cod ? order.deliveryFee : Money.zero()).toString(),
        pickup: { businessName: summary.businessName, ...sellerOrder.pickup },
        dropoff: { ...order.shipping },
        readyAt: readyAt.toISOString(),
      },
    });
  }
}

export interface SellerCaller {
  sellerId: string;
  userId: string;
}

/** The seller order must belong to the locked order (SELLER_ORDER_NOT_FOUND otherwise). */
function sellerOrderIn(locked: LockedOrder, sellerOrderId: string): SellerOrder {
  const sellerOrder = locked.sellerOrders.find((s) => s.id === sellerOrderId);
  if (!sellerOrder) throw sellerOrderNotFound();
  return sellerOrder;
}
