import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Money, Rate } from '../../../lib/money';
import { type PaymentMethod } from '../../payments';
import { ORDERING_TABLES } from '../constants';
import { OrderStatus } from '../enums';
import { type Order, type ShippingSnapshot } from '../model/order.model';

const T = ORDERING_TABLES.ORDERS;
const COLUMNS = [
  'id',
  'order_number',
  'customer_id',
  'status',
  'payment_method',
  'items_total',
  'delivery_fee',
  'agent_fee_share_rate',
  'total',
  'ship_governorate_id',
  'ship_governorate_name',
  'ship_recipient_name',
  'ship_recipient_phone',
  'ship_city',
  'ship_area',
  'ship_street',
  'ship_building',
  'ship_floor',
  'ship_apartment',
  'ship_landmark',
  'payment_expires_at',
  'placed_at',
  'completed_at',
  'cancelled_at',
  'created_at',
] as const;

interface OrderTable {
  id: string;
  order_number: string;
  customer_id: string;
  status: OrderStatus;
  payment_method: PaymentMethod;
  items_total: string;
  delivery_fee: string;
  agent_fee_share_rate: string;
  total: string;
  ship_governorate_id: string;
  ship_governorate_name: string;
  ship_recipient_name: string;
  ship_recipient_phone: string;
  ship_city: string;
  ship_area: string;
  ship_street: string;
  ship_building: string;
  ship_floor: string | null;
  ship_apartment: string | null;
  ship_landmark: string | null;
  payment_expires_at: Date | null;
  placed_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type OrderRow = Pick<OrderTable, (typeof COLUMNS)[number]>;

function toModel(row: OrderRow): Order {
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    status: row.status,
    paymentMethod: row.payment_method,
    itemsTotal: Money.of(row.items_total),
    deliveryFee: Money.of(row.delivery_fee),
    agentFeeShareRate: Rate.of(row.agent_fee_share_rate),
    total: Money.of(row.total),
    shipping: {
      recipientName: row.ship_recipient_name,
      recipientPhone: row.ship_recipient_phone,
      governorateId: row.ship_governorate_id,
      governorateName: row.ship_governorate_name,
      city: row.ship_city,
      area: row.ship_area,
      street: row.ship_street,
      building: row.ship_building,
      floor: row.ship_floor,
      apartment: row.ship_apartment,
      landmark: row.ship_landmark,
    },
    paymentExpiresAt: row.payment_expires_at,
    placedAt: row.placed_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
  };
}

export interface NewOrder {
  customerId: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  itemsTotal: Money;
  deliveryFee: Money;
  agentFeeShareRate: Rate;
  total: Money;
  shipping: ShippingSnapshot;
  paymentExpiresAt: Date | null;
  placedAt: Date | null;
}

export interface OrderStateUpdate {
  status: OrderStatus;
  itemsTotal: Money;
  deliveryFee: Money;
  total: Money;
  completedAt: Date | null;
  cancelledAt: Date | null;
}

@injectable()
export class OrderRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** The order number comes from `order_number_seq` in the same INSERT (SD-10). */
  async insert(order: NewOrder, trx: DbTransaction): Promise<Order> {
    const [row] = await trx<OrderTable>(T)
      .insert({
        order_number: trx.raw(`'NM-' || lpad(nextval('order_number_seq')::text, 9, '0')`),
        customer_id: order.customerId,
        status: order.status,
        payment_method: order.paymentMethod,
        items_total: order.itemsTotal.toString(),
        delivery_fee: order.deliveryFee.toString(),
        agent_fee_share_rate: order.agentFeeShareRate.toString(),
        total: order.total.toString(),
        ship_governorate_id: order.shipping.governorateId,
        ship_governorate_name: order.shipping.governorateName,
        ship_recipient_name: order.shipping.recipientName,
        ship_recipient_phone: order.shipping.recipientPhone,
        ship_city: order.shipping.city,
        ship_area: order.shipping.area,
        ship_street: order.shipping.street,
        ship_building: order.shipping.building,
        ship_floor: order.shipping.floor,
        ship_apartment: order.shipping.apartment,
        ship_landmark: order.shipping.landmark,
        payment_expires_at: order.paymentExpiresAt,
        placed_at: order.placedAt,
        completed_at: null,
        cancelled_at: null,
      })
      .returning<OrderRow[]>(COLUMNS);
    if (!row) throw new Error('orders insert returned no row');
    return toModel(row);
  }

  async findById(id: string, trx?: DbTransaction): Promise<Order | null> {
    const row = await this.exec(trx)<OrderTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .first<OrderRow | undefined>();
    return row ? toModel(row) : null;
  }

  /**
   * Locks the order row (`FOR UPDATE`): every write that touches a checkout takes it first (spec 09
   * §1.2, OR-3). With `skipLocked` a busy order returns null (the jobs, OR-5).
   */
  async lock(id: string, trx: DbTransaction, options: { skipLocked?: boolean } = {}): Promise<Order | null> {
    const qb = trx<OrderTable>(T)
      .select(...COLUMNS)
      .where({ id });
    void (options.skipLocked ? qb.forUpdate().skipLocked() : qb.forUpdate());
    const row = await qb.first<OrderRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** A Kashier order placed on payment (spec 09 §3.11), under the order lock the caller holds. */
  async setPlacedAt(id: string, placedAt: Date, trx: DbTransaction): Promise<void> {
    await trx<OrderTable>(T).update({ placed_at: placedAt, updated_at: trx.fn.now() }).where({ id });
  }

  /**
   * Kashier orders whose payment window closed, oldest first, read without locks (OR-5):
   * idx_orders_payment_expires_at WHERE status = 'pending_payment'.
   */
  async findIdsPastPaymentExpiry(now: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .knex<OrderTable>(T)
      .select('id')
      .where({ status: OrderStatus.PENDING_PAYMENT })
      .where('payment_expires_at', '<', now)
      .orderBy('payment_expires_at')
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** Writes the derived state computed under the order lock the caller holds (spec 09 §1.1, §3.9). */
  async updateState(id: string, state: OrderStateUpdate, trx: DbTransaction): Promise<void> {
    await trx<OrderTable>(T)
      .update({
        status: state.status,
        items_total: state.itemsTotal.toString(),
        delivery_fee: state.deliveryFee.toString(),
        total: state.total.toString(),
        completed_at: state.completedAt,
        cancelled_at: state.cancelledAt,
        updated_at: trx.fn.now(),
      })
      .where({ id });
  }

  /** One batched `id IN (...)` query (G20). */
  async findByIds(ids: readonly string[], trx?: DbTransaction): Promise<Order[]> {
    if (ids.length === 0) return [];
    const rows = await this.exec(trx)<OrderTable>(T)
      .select(...COLUMNS)
      .whereIn('id', [...new Set(ids)]);
    return rows.map(toModel);
  }

  /**
   * A keyset page (`limit + 1` rows) of orders, optionally of one customer
   * (idx_orders_customer_id_created_at_id, else the status / created_at indexes, D-8).
   */
  async list(query: ParsedListQuery, scope: { customerId?: string }, trx?: DbTransaction): Promise<Order[]> {
    const qb = this.exec(trx)<OrderTable>(T).select(...COLUMNS);
    if (scope.customerId) void qb.where({ customer_id: scope.customerId });
    const rows = (await applyListQuery(qb, query, 'id')) as OrderRow[];
    return rows.map(toModel);
  }
}
