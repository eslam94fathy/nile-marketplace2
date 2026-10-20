import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type NotificationParty, type OrderLink } from '../model/notification-party.model';
import { type OrderRepository } from '../repository/order.repository';
import { type SellerOrderRepository } from '../repository/seller-order.repository';

/**
 * Public API of ordering (spec 09 §8.1) for the R2 modules that depend on it (realtime, notifications,
 * support). Reads without locks and without a transaction: none of the callers needs one. Current
 * state is re-read, never taken from an event payload (spec 02 §6.3).
 */
export interface IOrderingDirectory {
  /**
   * Batched. Each order named directly or through one of its seller orders, once, with all its seller
   * orders. Unknown ids are left out.
   */
  getNotificationParties(ids: {
    orderIds?: readonly string[];
    sellerOrderIds?: readonly string[];
  }): Promise<NotificationParty[]>;
  /** Null when missing, another customer's, or `sellerOrderId` isn't part of the order. */
  getCustomerOrderLink(
    customerId: string,
    orderId: string,
    sellerOrderId?: string,
  ): Promise<OrderLink | null>;
  /** Null when missing, another seller's, or still awaiting payment (spec 09 §4.2). */
  getSellerOrderLink(sellerId: string, sellerOrderId: string): Promise<OrderLink | null>;
  /** Batched; unknown ids are left out. */
  getOrderNumbers(orderIds: readonly string[]): Promise<Map<string, string>>;
}

@injectable()
export class OrderingDirectory implements IOrderingDirectory {
  constructor(
    @inject(TOKENS.OrderRepository) private readonly orders: OrderRepository,
    @inject(TOKENS.SellerOrderRepository) private readonly sellerOrders: SellerOrderRepository,
  ) {}

  async getNotificationParties(ids: {
    orderIds?: readonly string[];
    sellerOrderIds?: readonly string[];
  }): Promise<NotificationParty[]> {
    const named = await this.sellerOrders.findByIds(ids.sellerOrderIds ?? []);
    const orderIds = [...new Set([...(ids.orderIds ?? []), ...named.map((s) => s.orderId)])];
    const [orders, sellerOrders] = await Promise.all([
      this.orders.findByIds(orderIds),
      this.sellerOrders.findByOrderIds(orderIds),
    ]);
    return orders.map((order) => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      status: order.status,
      sellerOrders: sellerOrders
        .filter((s) => s.orderId === order.id)
        .map((s) => ({ sellerOrderId: s.id, sellerId: s.sellerId, status: s.status })),
    }));
  }

  async getCustomerOrderLink(
    customerId: string,
    orderId: string,
    sellerOrderId?: string,
  ): Promise<OrderLink | null> {
    const order = await this.orders.findById(orderId);
    if (!order || order.customerId !== customerId) return null;
    if (sellerOrderId === undefined) return { orderId, orderNumber: order.orderNumber, sellerOrderId: null };
    const [sellerOrder] = await this.sellerOrders.findByIds([sellerOrderId]);
    if (sellerOrder?.orderId !== orderId) return null;
    return { orderId, orderNumber: order.orderNumber, sellerOrderId };
  }

  async getSellerOrderLink(sellerId: string, sellerOrderId: string): Promise<OrderLink | null> {
    const sellerOrder = await this.sellerOrders.findForSeller(sellerOrderId, sellerId);
    if (!sellerOrder) return null;
    const orderNumber = (await this.orders.findOrderNumbers([sellerOrder.orderId])).get(sellerOrder.orderId);
    if (orderNumber === undefined) throw new Error(`seller order ${sellerOrderId} has no order`);
    return { orderId: sellerOrder.orderId, orderNumber, sellerOrderId };
  }

  getOrderNumbers(orderIds: readonly string[]): Promise<Map<string, string>> {
    return this.orders.findOrderNumbers(orderIds);
  }
}
