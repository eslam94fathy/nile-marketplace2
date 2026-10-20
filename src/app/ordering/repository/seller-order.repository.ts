import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Money, Rate } from '../../../lib/money';
import { ORDERING_TABLES } from '../constants';
import { type SellerOrderCancelReason, SellerOrderStatus } from '../enums';
import { type PickupSnapshot, type SellerOrder } from '../model/order.model';

const T = ORDERING_TABLES.SELLER_ORDERS;
const COLUMNS = [
  'id',
  'order_id',
  'seller_id',
  'status',
  'subtotal',
  'commission_rate',
  'commission',
  'seller_net',
  'pickup_governorate_id',
  'pickup_phone',
  'pickup_city',
  'pickup_area',
  'pickup_street',
  'pickup_building',
  'pickup_landmark',
  'accept_deadline_at',
  'cancel_reason',
  'cancelled_by_user_id',
  'accepted_at',
  'ready_at',
  'picked_up_at',
  'delivered_at',
  'returned_at',
  'cancelled_at',
  'created_at',
] as const;

interface SellerOrderTable {
  id: string;
  order_id: string;
  seller_id: string;
  status: SellerOrderStatus;
  subtotal: string;
  commission_rate: string;
  commission: string;
  seller_net: string;
  pickup_governorate_id: string;
  pickup_phone: string;
  pickup_city: string;
  pickup_area: string;
  pickup_street: string;
  pickup_building: string;
  pickup_landmark: string | null;
  accept_deadline_at: Date | null;
  cancel_reason: SellerOrderCancelReason | null;
  cancelled_by_user_id: string | null;
  accepted_at: Date | null;
  ready_at: Date | null;
  picked_up_at: Date | null;
  delivered_at: Date | null;
  returned_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type SellerOrderRow = Pick<SellerOrderTable, (typeof COLUMNS)[number]>;

function toModel(row: SellerOrderRow): SellerOrder {
  return {
    id: row.id,
    orderId: row.order_id,
    sellerId: row.seller_id,
    status: row.status,
    subtotal: Money.of(row.subtotal),
    commissionRate: Rate.of(row.commission_rate),
    commission: Money.of(row.commission),
    sellerNet: Money.of(row.seller_net),
    pickup: {
      governorateId: row.pickup_governorate_id,
      phone: row.pickup_phone,
      city: row.pickup_city,
      area: row.pickup_area,
      street: row.pickup_street,
      building: row.pickup_building,
      landmark: row.pickup_landmark,
    },
    acceptDeadlineAt: row.accept_deadline_at,
    cancelReason: row.cancel_reason,
    cancelledByUserId: row.cancelled_by_user_id,
    acceptedAt: row.accepted_at,
    readyAt: row.ready_at,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    returnedAt: row.returned_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
  };
}

export interface NewSellerOrder {
  orderId: string;
  sellerId: string;
  status: SellerOrderStatus;
  subtotal: Money;
  commissionRate: Rate;
  commission: Money;
  sellerNet: Money;
  pickup: PickupSnapshot;
  acceptDeadlineAt: Date | null;
}

/** What a transition writes besides the status: only the timestamps and cancel fields it sets. */
export interface SellerOrderTransition {
  status: SellerOrderStatus;
  /** Set when a Kashier order is placed on payment (spec 09 §3.11). */
  acceptDeadlineAt?: Date;
  acceptedAt?: Date;
  readyAt?: Date;
  pickedUpAt?: Date;
  deliveredAt?: Date;
  returnedAt?: Date;
  cancel?: { reason: SellerOrderCancelReason; byUserId: string | null; at: Date };
}

@injectable()
export class SellerOrderRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** One multi-row insert (CLAUDE.md §6.4); rows come back in insert order. */
  async insertMany(sellerOrders: readonly NewSellerOrder[], trx: DbTransaction): Promise<SellerOrder[]> {
    const rows = await trx<SellerOrderTable>(T)
      .insert(
        sellerOrders.map((s) => ({
          order_id: s.orderId,
          seller_id: s.sellerId,
          status: s.status,
          subtotal: s.subtotal.toString(),
          commission_rate: s.commissionRate.toString(),
          commission: s.commission.toString(),
          seller_net: s.sellerNet.toString(),
          pickup_governorate_id: s.pickup.governorateId,
          pickup_phone: s.pickup.phone,
          pickup_city: s.pickup.city,
          pickup_area: s.pickup.area,
          pickup_street: s.pickup.street,
          pickup_building: s.pickup.building,
          pickup_landmark: s.pickup.landmark,
          accept_deadline_at: s.acceptDeadlineAt,
          cancel_reason: null,
          cancelled_by_user_id: null,
          cancelled_at: null,
        })),
      )
      .returning<SellerOrderRow[]>(COLUMNS);
    const bySeller = new Map(rows.map((row) => [row.seller_id, toModel(row)]));
    return sellerOrders.map((s) => {
      const inserted = bySeller.get(s.sellerId);
      if (!inserted) throw new Error(`seller_orders insert returned no row for seller ${s.sellerId}`);
      return inserted;
    });
  }

  /** The seller orders of orders: WHERE order_id = ANY(?) over uq_seller_orders_order_id_seller_id (G20). */
  async findByOrderIds(orderIds: readonly string[], trx?: DbTransaction): Promise<SellerOrder[]> {
    if (orderIds.length === 0) return [];
    const rows = await this.exec(trx)<SellerOrderTable>(T)
      .select(...COLUMNS)
      .whereIn('order_id', [...new Set(orderIds)])
      .orderBy([{ column: 'created_at' }, { column: 'id' }]);
    return rows.map(toModel);
  }

  /** One batched query on the primary key (G20); unknown ids are left out. */
  async findByIds(ids: readonly string[]): Promise<SellerOrder[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .knex<SellerOrderTable>(T)
      .select(...COLUMNS)
      .whereIn('id', [...new Set(ids)]);
    return rows.map(toModel);
  }

  /** Locks the seller orders of a locked order, in id order (spec 09 §1.2, OR-3). */
  async lockByOrderId(orderId: string, trx: DbTransaction): Promise<SellerOrder[]> {
    const rows = await trx<SellerOrderTable>(T)
      .select(...COLUMNS)
      .where({ order_id: orderId })
      .orderBy('id')
      .forUpdate();
    return rows.map(toModel);
  }

  /**
   * Conditional transition (spec 09 §1.2): applies only if the status is still one of `from`.
   * Returns the row after the change, or null when it had moved on.
   */
  async transition(
    id: string,
    from: readonly SellerOrderStatus[],
    change: SellerOrderTransition,
    trx: DbTransaction,
  ): Promise<SellerOrder | null> {
    const [row] = await trx<SellerOrderTable>(T)
      .update({
        status: change.status,
        ...(change.acceptDeadlineAt ? { accept_deadline_at: change.acceptDeadlineAt } : {}),
        ...(change.acceptedAt ? { accepted_at: change.acceptedAt } : {}),
        ...(change.readyAt ? { ready_at: change.readyAt } : {}),
        ...(change.pickedUpAt ? { picked_up_at: change.pickedUpAt } : {}),
        ...(change.deliveredAt ? { delivered_at: change.deliveredAt } : {}),
        ...(change.returnedAt ? { returned_at: change.returnedAt } : {}),
        ...(change.cancel
          ? {
              cancel_reason: change.cancel.reason,
              cancelled_by_user_id: change.cancel.byUserId,
              cancelled_at: change.cancel.at,
            }
          : {}),
        updated_at: trx.fn.now(),
      })
      .where({ id })
      .whereIn('status', [...from])
      .returning<SellerOrderRow[]>(COLUMNS);
    return row ? toModel(row) : null;
  }

  /** Partial item cancellation (spec 09 §3.5 step 3), under the order lock. */
  async updateMoney(
    id: string,
    money: { subtotal: Money; commission: Money; sellerNet: Money },
    trx: DbTransaction,
  ): Promise<void> {
    await trx<SellerOrderTable>(T)
      .update({
        subtotal: money.subtotal.toString(),
        commission: money.commission.toString(),
        seller_net: money.sellerNet.toString(),
        updated_at: trx.fn.now(),
      })
      .where({ id });
  }

  /**
   * Orders with a placed seller order past its acceptance deadline, oldest deadline first, read
   * without locks (OR-5): idx_seller_orders_accept_deadline_at WHERE status = 'placed'.
   */
  async findOrderIdsPastAcceptDeadline(now: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .knex<SellerOrderTable>(T)
      .select('order_id')
      .where({ status: SellerOrderStatus.PLACED })
      .where('accept_deadline_at', '<', now)
      .orderBy('accept_deadline_at')
      .limit(limit);
    return [...new Set(rows.map((row) => row.order_id))];
  }

  /** One of the seller's orders, never while it awaits payment (spec 09 §4.2). */
  async findForSeller(id: string, sellerId: string, trx?: DbTransaction): Promise<SellerOrder | null> {
    const row = await this.exec(trx)<SellerOrderTable>(T)
      .select(...COLUMNS)
      .where({ id, seller_id: sellerId })
      .whereNot({ status: SellerOrderStatus.PENDING_PAYMENT })
      .first<SellerOrderRow | undefined>();
    return row ? toModel(row) : null;
  }

  /**
   * The seller dashboard, keyset page (`limit + 1` rows): idx_seller_orders_seller_id_status_created_at_id
   * with a status filter, idx_seller_orders_seller_id_created_at_id without. pending_payment is never shown.
   */
  async listForSeller(sellerId: string, query: ParsedListQuery, trx?: DbTransaction): Promise<SellerOrder[]> {
    const qb = this.exec(trx)<SellerOrderTable>(T)
      .select(...COLUMNS)
      .where({ seller_id: sellerId })
      .whereNot({ status: SellerOrderStatus.PENDING_PAYMENT });
    const rows = (await applyListQuery(qb, query, 'id')) as SellerOrderRow[];
    return rows.map(toModel);
  }
}
