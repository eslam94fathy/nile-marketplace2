import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { ORDERING_TABLES } from '../constants';
import { type OrderItem } from '../model/order.model';

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
  'line_total',
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
  line_total: string;
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
    lineTotal: Money.of(row.line_total),
    imageMediaId: row.image_media_id,
  };
}

export type NewOrderItem = Omit<OrderItem, 'id' | 'cancelledQuantity'>;

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
          line_total: item.lineTotal.toString(),
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
    trx: DbTransaction,
  ): Promise<void> {
    await trx<OrderItemTable>(T)
      .update({
        cancelled_quantity: cancelledQuantity,
        line_total: lineTotal.toString(),
        updated_at: trx.fn.now(),
      })
      .where({ id });
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
}
