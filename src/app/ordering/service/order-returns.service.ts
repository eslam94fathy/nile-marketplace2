import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ISellerDirectory } from '../../sellers';
import { SellerOrderStatus } from '../enums';
import { returnQuantityInvalid, sellerOrderNotFound } from '../errors';
import { keptQuantity, type OrderItem, type SellerOrder } from '../model/order.model';
import {
  computeReturnAmounts,
  keptDiscountOf,
  type OrderItemSnapshot,
  type ReturnableSellerOrder,
  type ReturnAmounts,
  type ReturnLine,
  type ReturnLogistics,
  returnBaseOf,
  returnLineProblems,
} from '../model/return.model';
import { type OrderItemReturnRepository } from '../repository/order-item-return.repository';
import { type OrderItemRepository } from '../repository/order-item.repository';
import { type OrderRepository } from '../repository/order.repository';
import { type SellerOrderRepository } from '../repository/seller-order.repository';
import { type OrderLifecycleService } from './order-lifecycle.service';

/**
 * Public API of ordering for returns (spec 09 §8.7, spec 18 UC-RE-1, UC-RE-4, UC-RE-7). The reads take
 * no locks; `recordReturn` runs in the returns transaction, after the return row is locked (lock order
 * return_requests → orders → seller_orders → inventory_items, spec 18 UC-RE-7). Ordering publishes
 * nothing for a return: returns publishes `return.completed`.
 */
export interface IOrderReturns {
  /** Null when the seller order is missing or not this customer's. */
  getReturnableItems(customerId: string, sellerOrderId: string): Promise<ReturnableSellerOrder | null>;
  /**
   * The request estimate; same rule as `recordReturn`, without locks. Throws `RETURN_QUANTITY_INVALID`
   * (details per line) and `SELLER_ORDER_NOT_FOUND`.
   */
  quoteReturn(sellerOrderId: string, lines: readonly ReturnLine[]): Promise<ReturnAmounts>;
  /** Batched line snapshots for the return views (OR-30); unknown ids are left out. */
  getOrderItems(orderItemIds: readonly string[]): Promise<OrderItemSnapshot[]>;
  /** Pickup = the customer, drop-off = the seller (spec 09 §8.7). Null when the seller order is missing. */
  getReturnLogistics(sellerOrderId: string): Promise<ReturnLogistics | null>;
  /**
   * UC-RE-7 step 2: locks the order and its seller orders, checks the quantities again, records the
   * returned units and amounts. Throws `RETURN_QUANTITY_INVALID`; a seller order that isn't delivered
   * is a caller bug.
   */
  recordReturn(
    input: { sellerOrderId: string; returnId: string; lines: readonly ReturnLine[] },
    trx: DbTransaction,
  ): Promise<ReturnAmounts>;
}

@injectable()
export class OrderReturnService implements IOrderReturns {
  constructor(
    @inject(TOKENS.OrderRepository) private readonly orders: OrderRepository,
    @inject(TOKENS.SellerOrderRepository) private readonly sellerOrders: SellerOrderRepository,
    @inject(TOKENS.OrderItemRepository) private readonly items: OrderItemRepository,
    @inject(TOKENS.OrderItemReturnRepository) private readonly itemReturns: OrderItemReturnRepository,
    @inject(TOKENS.OrderLifecycleService) private readonly lifecycle: OrderLifecycleService,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
  ) {}

  async getReturnableItems(customerId: string, sellerOrderId: string): Promise<ReturnableSellerOrder | null> {
    const [sellerOrder] = await this.sellerOrders.findByIds([sellerOrderId]);
    if (!sellerOrder) return null;
    const order = await this.orders.findById(sellerOrder.orderId);
    if (!order || order.customerId !== customerId) return null;
    const items = await this.items.findBySellerOrderIds([sellerOrderId]);
    return {
      sellerOrderId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      sellerId: sellerOrder.sellerId,
      status: sellerOrder.status,
      deliveredAt: sellerOrder.deliveredAt,
      paymentMethod: order.paymentMethod,
      dropoffGovernorateId: order.shipping.governorateId,
      items: items
        .filter((item) => keptQuantity(item) > 0)
        .map((item) => ({
          orderItemId: item.id,
          productName: item.productName,
          attributes: item.attributes,
          imageMediaId: item.imageMediaId,
          returnable: keptQuantity(item),
          // Indicative (the exact share of k units comes from the amount rule): the price less one unit's share.
          paidUnitAmount: item.unitPrice.minus(keptDiscountOf(item, 1)),
        })),
    };
  }

  async quoteReturn(sellerOrderId: string, lines: readonly ReturnLine[]): Promise<ReturnAmounts> {
    const [sellerOrder] = await this.sellerOrders.findByIds([sellerOrderId]);
    if (!sellerOrder) throw sellerOrderNotFound();
    const items = await this.items.findBySellerOrderIds([sellerOrderId]);
    return amountsOf(sellerOrder, items, lines).amounts;
  }

  async getOrderItems(orderItemIds: readonly string[]): Promise<OrderItemSnapshot[]> {
    return (await this.items.findByIds(orderItemIds)).map((item) => ({
      orderItemId: item.id,
      sellerOrderId: item.sellerOrderId,
      variantId: item.variantId,
      productName: item.productName,
      attributes: item.attributes,
      imageMediaId: item.imageMediaId,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      discountOriginal: item.discountOriginal,
    }));
  }

  async getReturnLogistics(sellerOrderId: string): Promise<ReturnLogistics | null> {
    const [sellerOrder] = await this.sellerOrders.findByIds([sellerOrderId]);
    if (!sellerOrder) return null;
    const [order, [seller]] = await Promise.all([
      this.orders.findById(sellerOrder.orderId),
      this.sellers.getSummaries([sellerOrder.sellerId]),
    ]);
    // Both are RESTRICT FKs of the seller order.
    if (!order) throw new Error(`seller order ${sellerOrderId} has no order`);
    if (!seller) throw new Error(`seller order ${sellerOrderId} has no seller ${sellerOrder.sellerId}`);
    return {
      orderNumber: order.orderNumber,
      paymentMethod: order.paymentMethod,
      pickup: { ...order.shipping },
      dropoff: { ...sellerOrder.pickup, businessName: seller.businessName },
    };
  }

  async recordReturn(
    input: { sellerOrderId: string; returnId: string; lines: readonly ReturnLine[] },
    trx: DbTransaction,
  ): Promise<ReturnAmounts> {
    const [found] = await this.sellerOrders.findByIds([input.sellerOrderId]);
    if (!found) throw new Error(`seller order ${input.sellerOrderId} not found`);
    const locked = await this.lifecycle.lock(found.orderId, trx);
    const sellerOrder = locked?.sellerOrders.find((s) => s.id === input.sellerOrderId);
    if (!sellerOrder) throw new Error(`seller order ${input.sellerOrderId} vanished under its order lock`);
    if (sellerOrder.status !== SellerOrderStatus.DELIVERED) {
      throw new Error(`seller order ${sellerOrder.id} is ${sellerOrder.status}, not delivered`);
    }

    const items = await this.items.findBySellerOrderIds([sellerOrder.id], trx);
    const { amounts, lines } = amountsOf(sellerOrder, items, input.lines);
    for (const line of lines) {
      // The order lock serialises every change of these lines, so a refusal is an invariant violation.
      if (!(await this.items.addReturned(line.orderItemId, line.quantity, trx))) {
        throw new Error(`order item ${line.orderItemId} has fewer than ${line.quantity} units kept`);
      }
    }
    await this.itemReturns.insertMany(input.returnId, lines, trx);
    await this.sellerOrders.addReturned(sellerOrder.id, amounts, trx);
    return amounts;
  }
}

function amountsOf(sellerOrder: SellerOrder, items: readonly OrderItem[], lines: readonly ReturnLine[]) {
  const problems = returnLineProblems(items, lines);
  if (lines.length === 0 || problems.length > 0) throw returnQuantityInvalid(problems);
  return computeReturnAmounts(returnBaseOf(sellerOrder), items, lines);
}
