import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type DashboardStatsQuery, type OrderingDashboardStats } from '../model/dashboard-stats.model';
import { type NotificationParty, type OrderLink } from '../model/notification-party.model';
import {
  type DeliveredItem,
  type DeliveredItemsQuery,
  type ReviewableItem,
} from '../model/reviewable-item.model';
import { type OrderItemRepository } from '../repository/order-item.repository';
import { type OrderRepository } from '../repository/order.repository';
import { type OrderingStatsRepository } from '../repository/ordering-stats.repository';
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
  /** A delivered item of the customer (spec 17 UC-RV-1); null when not theirs or not delivered. */
  getReviewableItem(customerId: string, orderItemId: string): Promise<ReviewableItem | null>;
  /** Open delivered items for `GET /me/reviewable-items`, newest delivery first (OR-26). */
  listDeliveredItems(customerId: string, query: DeliveredItemsQuery): Promise<DeliveredItem[]>;
  /** The back-office dashboard figures (spec 20 §3.2, BO-12, BO-13, BO-20, BO-22). */
  getDashboardStats(query: DashboardStatsQuery): Promise<OrderingDashboardStats>;
}

@injectable()
export class OrderingDirectory implements IOrderingDirectory {
  constructor(
    @inject(TOKENS.OrderRepository) private readonly orders: OrderRepository,
    @inject(TOKENS.SellerOrderRepository) private readonly sellerOrders: SellerOrderRepository,
    @inject(TOKENS.OrderItemRepository) private readonly items: OrderItemRepository,
    @inject(TOKENS.OrderingStatsRepository) private readonly stats: OrderingStatsRepository,
  ) {}

  getDashboardStats(query: DashboardStatsQuery): Promise<OrderingDashboardStats> {
    return this.stats.getDashboardStats(query);
  }

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

  getReviewableItem(customerId: string, orderItemId: string): Promise<ReviewableItem | null> {
    return this.items.findReviewable(customerId, orderItemId);
  }

  listDeliveredItems(customerId: string, query: DeliveredItemsQuery): Promise<DeliveredItem[]> {
    return this.items.listDelivered(customerId, query);
  }
}
