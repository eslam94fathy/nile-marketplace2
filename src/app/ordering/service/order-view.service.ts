import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type MediaService } from '../../media';
import { type IPaymentDirectory } from '../../payments';
import { type ISellerDirectory } from '../../sellers';
import { orderNotFound, sellerOrderNotFound } from '../errors';
import { isBilled } from '../model/order-status.model';
import { type OrderDetail, type OrderItemView, type SellerOrderView } from '../model/order-view.model';
import {
  type Order,
  type OrderItem,
  type OrderListEntry,
  openQuantity,
  type SellerOrder,
} from '../model/order.model';
import { type OrderItemRepository } from '../repository/order-item.repository';
import { type OrderRepository } from '../repository/order.repository';
import { type SellerOrderRepository } from '../repository/seller-order.repository';
import { type StatusHistoryRepository } from '../repository/status-history.repository';

/**
 * Order reads (spec 09 §4): customer, seller and admin views. Every view loads its related rows with
 * one batched query per table (G20, OR-9); business names come live from sellers, line images in one
 * media read per view (spec 09 §8.3).
 */
@injectable()
export class OrderViewService {
  constructor(
    @inject(TOKENS.OrderRepository) private readonly orders: OrderRepository,
    @inject(TOKENS.SellerOrderRepository) private readonly sellerOrders: SellerOrderRepository,
    @inject(TOKENS.OrderItemRepository) private readonly items: OrderItemRepository,
    @inject(TOKENS.StatusHistoryRepository) private readonly history: StatusHistoryRepository,
    @inject(TOKENS.PaymentDirectory) private readonly payments: IPaymentDirectory,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
  ) {}

  /** ORDER_NOT_FOUND for another customer's order: never tell them apart. */
  async getForCustomer(customerId: string, orderId: string): Promise<OrderDetail> {
    const order = await this.orders.findById(orderId);
    if (!order || order.customerId !== customerId) throw orderNotFound();
    return this.detailOf(order);
  }

  async getForAdmin(orderId: string): Promise<OrderDetail> {
    const order = await this.orders.findById(orderId);
    if (!order) throw orderNotFound();
    return this.detailOf(order);
  }

  async listForCustomer(
    customerId: string,
    query: ParsedListQuery,
  ): Promise<{ items: OrderListEntry[]; meta: PageMeta }> {
    return this.listEntries(await this.orders.list(query, { customerId }), query);
  }

  async listForAdmin(query: ParsedListQuery): Promise<{ items: OrderListEntry[]; meta: PageMeta }> {
    return this.listEntries(await this.orders.list(query, {}), query);
  }

  /** SELLER_ORDER_NOT_FOUND for another seller's, or one still awaiting payment (spec 09 §4.2). */
  async getForSeller(sellerId: string, sellerOrderId: string): Promise<SellerOrderView> {
    const sellerOrder = await this.sellerOrders.findForSeller(sellerOrderId, sellerId);
    if (!sellerOrder) throw sellerOrderNotFound();
    const [view] = await this.sellerViews([sellerOrder]);
    if (!view) throw new Error(`seller order ${sellerOrder.id} has no order`);
    return view;
  }

  async listForSeller(
    sellerId: string,
    query: ParsedListQuery,
  ): Promise<{ items: SellerOrderView[]; meta: PageMeta }> {
    const page = toPage(await this.sellerOrders.listForSeller(sellerId, query), query, (s) => s.createdAt);
    return { items: await this.sellerViews(page.items), meta: page.meta };
  }

  private async detailOf(order: Order): Promise<OrderDetail> {
    const sellerOrders = await this.sellerOrders.findByOrderIds([order.id]);
    const sellerOrderIds = sellerOrders.map((s) => s.id);
    const [items, sellerHistory, orderHistory, payments, names] = await Promise.all([
      this.items.findBySellerOrderIds(sellerOrderIds).then((rows) => this.withImages(rows)),
      this.history.listForSellerOrders(sellerOrderIds),
      this.history.listForOrders([order.id]),
      this.payments.getSummaries([order.id]),
      this.businessNames(sellerOrders),
    ]);
    return {
      order,
      payment: payments[0] ?? null,
      history: orderHistory,
      sellerOrders: sellerOrders.map((sellerOrder) => ({
        sellerOrder,
        businessName: requireName(names, sellerOrder.sellerId),
        items: items.filter((item) => item.sellerOrderId === sellerOrder.id),
        history: sellerHistory.filter((entry) => entry.subjectId === sellerOrder.id),
      })),
    };
  }

  /**
   * Counts for the summaries, from two batched reads: seller orders, and units still on order (OR-9):
   * open quantities of the seller orders still billed. A whole cancelled or returned seller order keeps
   * its lines' quantities (only item cancellations set cancelled_quantity), so it is left out by status.
   */
  private async listEntries(
    rows: Order[],
    query: ParsedListQuery,
  ): Promise<{ items: OrderListEntry[]; meta: PageMeta }> {
    const page = toPage(rows, query, (order) => order.createdAt);
    const sellerOrders = await this.sellerOrders.findByOrderIds(page.items.map((o) => o.id));
    const items = await this.items.findBySellerOrderIds(sellerOrders.map((s) => s.id));
    const billedOrderOf = new Map(
      sellerOrders.filter((s) => isBilled(s.status)).map((s) => [s.id, s.orderId]),
    );
    return {
      meta: page.meta,
      items: page.items.map((order) => ({
        order,
        sellerOrderCount: sellerOrders.filter((s) => s.orderId === order.id).length,
        itemCount: items
          .filter((item) => billedOrderOf.get(item.sellerOrderId) === order.id)
          .reduce((sum, item) => sum + openQuantity(item), 0),
      })),
    };
  }

  private async sellerViews(sellerOrders: readonly SellerOrder[]): Promise<SellerOrderView[]> {
    const [orders, items] = await Promise.all([
      this.orders.findByIds(sellerOrders.map((s) => s.orderId)),
      this.items.findBySellerOrderIds(sellerOrders.map((s) => s.id)).then((rows) => this.withImages(rows)),
    ]);
    const orderById = new Map(orders.map((o) => [o.id, o]));
    return sellerOrders.map((sellerOrder) => {
      const order = orderById.get(sellerOrder.orderId);
      if (!order) throw new Error(`seller order ${sellerOrder.id} has no order`);
      return {
        sellerOrder,
        order: {
          orderNumber: order.orderNumber,
          paymentMethod: order.paymentMethod,
          dropoffGovernorate: { id: order.shipping.governorateId, name: order.shipping.governorateName },
        },
        items: items.filter((item) => item.sellerOrderId === sellerOrder.id),
      };
    });
  }

  /** A snapshot image that is somehow no longer ready is left out rather than failing the view. */
  private async withImages(items: readonly OrderItem[]): Promise<OrderItemView[]> {
    const images = await this.media.getImages(
      items.flatMap((item) => (item.imageMediaId === null ? [] : [item.imageMediaId])),
    );
    return items.map((item) => ({
      ...item,
      image: item.imageMediaId === null ? null : (images.get(item.imageMediaId) ?? null),
    }));
  }

  private async businessNames(sellerOrders: readonly SellerOrder[]): Promise<Map<string, string>> {
    const summaries = await this.sellers.getSummaries([...new Set(sellerOrders.map((s) => s.sellerId))]);
    return new Map(summaries.map((s) => [s.sellerId, s.businessName]));
  }
}

/** seller_orders.seller_id is a RESTRICT FK, so every seller order has its seller. */
function requireName(names: ReadonlyMap<string, string>, sellerId: string): string {
  const name = names.get(sellerId);
  if (name === undefined) throw new Error(`seller ${sellerId} has no summary`);
  return name;
}
