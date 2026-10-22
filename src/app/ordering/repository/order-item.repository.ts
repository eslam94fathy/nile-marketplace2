import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { ORDERING_TABLES } from '../constants';
import { SellerOrderStatus } from '../enums';
import { type OrderItem } from '../model/order.model';
import {
  type DeliveredItem,
  type DeliveredItemsQuery,
  type ReviewableItem,
} from '../model/reviewable-item.model';

const T = ORDERING_TABLES.ORDER_ITEMS;
const COLUMNS = [
  'id',
  'seller_order_id',
  'variant_id',
  'product_id',
  'product_name',
  'sku',
  'variant_attributes',
  'unit_price',
  'quantity',
  'cancelled_quantity',
  'returned_quantity',
  'line_total',
  'discount_original',
  'discount_amount',
  'image_media_id',
] as const;

interface OrderItemTable {
  id: string;
  seller_order_id: string;
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  variant_attributes: { attribute: string; value: string }[];
  unit_price: string;
  quantity: number;
  cancelled_quantity: number;
  returned_quantity: number;
  line_total: string;
  discount_original: string;
  discount_amount: string;
  image_media_id: string | null;
  created_at: Date;
  updated_at: Date;
}

type OrderItemRow = Pick<OrderItemTable, (typeof COLUMNS)[number]>;

function toModel(row: OrderItemRow): OrderItem {
  return {
    id: row.id,
    sellerOrderId: row.seller_order_id,
    variantId: row.variant_id,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    attributes: row.variant_attributes,
    unitPrice: Money.of(row.unit_price),
    quantity: row.quantity,
    cancelledQuantity: row.cancelled_quantity,
    returnedQuantity: row.returned_quantity,
    lineTotal: Money.of(row.line_total),
    discountOriginal: Money.of(row.discount_original),
    discountAmount: Money.of(row.discount_amount),
    imageMediaId: row.image_media_id,
  };
}

export type NewOrderItem = Omit<OrderItem, 'id' | 'cancelledQuantity' | 'returnedQuantity'>;

@injectable()
export class OrderItemRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** One multi-row insert (CLAUDE.md §6.4); nothing cancelled yet. */
  async insertMany(items: readonly NewOrderItem[], trx: DbTransaction): Promise<OrderItem[]> {
    const rows = await trx<OrderItemTable>(T)
      .insert(
        items.map((item) => ({
          seller_order_id: item.sellerOrderId,
          variant_id: item.variantId,
          product_id: item.productId,
          product_name: item.productName,
          sku: item.sku,
          variant_attributes: JSON.stringify(
            item.attributes,
          ) as unknown as OrderItemTable['variant_attributes'],
          unit_price: item.unitPrice.toString(),
          quantity: item.quantity,
          cancelled_quantity: 0,
          returned_quantity: 0,
          line_total: item.lineTotal.toString(),
          discount_original: item.discountOriginal.toString(),
          discount_amount: item.discountAmount.toString(),
          image_media_id: item.imageMediaId,
        })),
      )
      .returning<OrderItemRow[]>(COLUMNS);
    return rows.map(toModel);
  }

  /** Partial cancellation (spec 09 §3.5 step 1), under the order lock the caller holds. */
  async setCancelledQuantity(
    id: string,
    cancelledQuantity: number,
    lineTotal: Money,
    discountAmount: Money,
    trx: DbTransaction,
  ): Promise<void> {
    await trx<OrderItemTable>(T)
      .update({
        cancelled_quantity: cancelledQuantity,
        line_total: lineTotal.toString(),
        discount_amount: discountAmount.toString(),
        updated_at: trx.fn.now(),
      })
      .where({ id });
  }

  /**
   * Returned units (spec 09 §8.7), under the order lock the caller holds; conditional, so it never takes
   * more than is kept. False when it didn't apply.
   */
  async addReturned(id: string, quantity: number, trx: DbTransaction): Promise<boolean> {
    const updated = await trx<OrderItemTable>(T)
      .update({ returned_quantity: trx.raw('returned_quantity + ?', [quantity]), updated_at: trx.fn.now() })
      .where({ id })
      .whereRaw('quantity - cancelled_quantity - returned_quantity >= ?', [quantity]);
    return updated === 1;
  }

  /** One batched query on the primary key (G20); unknown ids are left out. */
  async findByIds(ids: readonly string[]): Promise<OrderItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .knex<OrderItemTable>(T)
      .select(...COLUMNS)
      .whereIn('id', [...new Set(ids)]);
    return rows.map(toModel);
  }

  /** The lines of seller orders: WHERE seller_order_id = ANY(?) over idx_order_items_seller_order_id (G20). */
  async findBySellerOrderIds(sellerOrderIds: readonly string[], trx?: DbTransaction): Promise<OrderItem[]> {
    if (sellerOrderIds.length === 0) return [];
    const rows = await this.exec(trx)<OrderItemTable>(T)
      .select(...COLUMNS)
      .whereIn('seller_order_id', [...new Set(sellerOrderIds)])
      .orderBy([{ column: 'created_at' }, { column: 'id' }]);
    return rows.map(toModel);
  }

  /**
   * One delivered item of the customer (spec 09 §8.1): order item → its seller order (delivered) → its
   * order (the customer's), all on primary keys. Null when missing, another customer's, or not delivered.
   */
  async findReviewable(customerId: string, orderItemId: string): Promise<ReviewableItem | null> {
    const row = await this.reviewableQuery()
      .where('oi.id', orderItemId)
      .andWhere('o.customer_id', customerId)
      .first<ReviewableRow | undefined>();
    return row ? toReviewable(row) : null;
  }

  /**
   * GET /me/reviewable-items (OR-26): the customer's open items of delivered seller orders since
   * `deliveredAfter`, newest delivery first, products in `excludeProductIds` left out. Keyset on the
   * delivery time truncated to milliseconds, then the item id (D-19: `delivered_at` is TIMESTAMPTZ(6)).
   * Found through the customer's orders; one customer's deliveries need no index of their own.
   */
  async listDelivered(customerId: string, query: DeliveredItemsQuery): Promise<DeliveredItem[]> {
    const qb = this.reviewableQuery()
      .select('o.order_number', 'oi.product_name', 'oi.image_media_id')
      .where('o.customer_id', customerId)
      .andWhere('so.delivered_at', '>=', query.deliveredAfter)
      .andWhereRaw('oi.quantity > oi.cancelled_quantity');
    if (query.excludeProductIds.length > 0) {
      void qb.whereNotIn('oi.product_id', [...new Set(query.excludeProductIds)]);
    }
    if (query.after) {
      void qb.whereRaw(`(${DELIVERED_AT_MS}, oi.id) < (?, ?)`, [
        query.after.deliveredAt,
        query.after.orderItemId,
      ]);
    }
    const rows = await qb
      .orderByRaw(`${DELIVERED_AT_MS} DESC, oi.id DESC`)
      .limit(query.limit)
      .select<DeliveredRow[]>();
    return rows.map((row) => ({
      ...toReviewable(row),
      orderNumber: row.order_number,
      productName: row.product_name,
      imageMediaId: row.image_media_id,
    }));
  }

  /** The join both reads share; only ordering's own tables (CLAUDE.md §2.2). */
  private reviewableQuery() {
    return this.db
      .knex(`${T} as oi`)
      .join(`${ORDERING_TABLES.SELLER_ORDERS} as so`, 'so.id', 'oi.seller_order_id')
      .join(`${ORDERING_TABLES.ORDERS} as o`, 'o.id', 'so.order_id')
      .select(
        'oi.id',
        'o.id as order_id',
        'oi.product_id',
        'oi.variant_id',
        'so.seller_id',
        this.db.knex.raw(`${DELIVERED_AT_MS} AS delivered_at`),
        this.db.knex.raw('oi.quantity - oi.cancelled_quantity AS open_quantity'),
        'oi.variant_attributes',
      )
      .where('so.status', SellerOrderStatus.DELIVERED)
      .whereNotNull('so.delivered_at');
  }
}

/** D-19: the cursor carries a JS Date (milliseconds), so the sort value is truncated to match. */
const DELIVERED_AT_MS = "date_trunc('milliseconds', so.delivered_at)";

interface ReviewableRow {
  id: string;
  order_id: string;
  product_id: string;
  variant_id: string;
  seller_id: string;
  delivered_at: Date;
  open_quantity: number;
  variant_attributes: { attribute: string; value: string }[];
}

interface DeliveredRow extends ReviewableRow {
  order_number: string;
  product_name: string;
  image_media_id: string | null;
}

function toReviewable(row: ReviewableRow): ReviewableItem {
  return {
    orderItemId: row.id,
    orderId: row.order_id,
    productId: row.product_id,
    variantId: row.variant_id,
    sellerId: row.seller_id,
    deliveredAt: row.delivered_at,
    openQuantity: Number(row.open_quantity),
    attributes: row.variant_attributes,
  };
}
