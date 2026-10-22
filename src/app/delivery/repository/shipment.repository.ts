import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Money } from '../../../lib/money';
import { DELIVERY_TABLES } from '../constants';
import { ACTIVE_SHIPMENT_STATUSES, ShipmentKind, ShipmentStatus } from '../enums';
import {
  type Shipment,
  type ShipmentDropoff,
  type ShipmentPaymentMethod,
  type ShipmentPickup,
} from '../model/shipment.model';

const T = DELIVERY_TABLES.SHIPMENTS;
const COLUMNS = [
  'id',
  'seller_order_id',
  'order_id',
  'agent_id',
  'status',
  'order_number',
  'payment_method',
  'order_delivery_fee',
  'pickup_business_name',
  'pickup_governorate_id',
  'pickup_phone',
  'pickup_city',
  'pickup_area',
  'pickup_street',
  'pickup_building',
  'pickup_landmark',
  'dropoff_recipient_name',
  'dropoff_recipient_phone',
  'dropoff_governorate_id',
  'dropoff_governorate_name',
  'dropoff_city',
  'dropoff_area',
  'dropoff_street',
  'dropoff_building',
  'dropoff_floor',
  'dropoff_apartment',
  'dropoff_landmark',
  'cod_items_amount',
  'carries_delivery_fee',
  'cod_fee_amount',
  'cod_collected_amount',
  'attempt_count',
  'assigned_at',
  'picked_up_at',
  'delivered_at',
  'returned_at',
  'seller_order_cancelled_at',
  'created_at',
] as const;

interface ShipmentTable {
  id: string;
  seller_order_id: string;
  order_id: string;
  agent_id: string | null;
  status: ShipmentStatus;
  order_number: string;
  payment_method: ShipmentPaymentMethod;
  order_delivery_fee: string;
  pickup_business_name: string;
  pickup_governorate_id: string;
  pickup_phone: string;
  pickup_city: string;
  pickup_area: string;
  pickup_street: string;
  pickup_building: string;
  pickup_landmark: string | null;
  dropoff_recipient_name: string;
  dropoff_recipient_phone: string;
  dropoff_governorate_id: string;
  dropoff_governorate_name: string;
  dropoff_city: string;
  dropoff_area: string;
  dropoff_street: string;
  dropoff_building: string;
  dropoff_floor: string | null;
  dropoff_apartment: string | null;
  dropoff_landmark: string | null;
  cod_items_amount: string;
  carries_delivery_fee: boolean;
  cod_fee_amount: string;
  cod_collected_amount: string | null;
  attempt_count: number;
  assigned_at: Date | null;
  picked_up_at: Date | null;
  delivered_at: Date | null;
  returned_at: Date | null;
  seller_order_cancelled_at: Date | null;
  kind: ShipmentKind;
  return_id: string | null;
  created_at: Date;
  updated_at: Date;
}

type ShipmentRow = Pick<ShipmentTable, (typeof COLUMNS)[number]>;

function toModel(row: ShipmentRow): Shipment {
  return {
    id: row.id,
    sellerOrderId: row.seller_order_id,
    orderId: row.order_id,
    agentId: row.agent_id,
    status: row.status,
    orderNumber: row.order_number,
    paymentMethod: row.payment_method,
    orderDeliveryFee: Money.of(row.order_delivery_fee),
    pickup: {
      businessName: row.pickup_business_name,
      phone: row.pickup_phone,
      governorateId: row.pickup_governorate_id,
      city: row.pickup_city,
      area: row.pickup_area,
      street: row.pickup_street,
      building: row.pickup_building,
      landmark: row.pickup_landmark,
    },
    dropoff: {
      recipientName: row.dropoff_recipient_name,
      recipientPhone: row.dropoff_recipient_phone,
      governorateId: row.dropoff_governorate_id,
      governorateName: row.dropoff_governorate_name,
      city: row.dropoff_city,
      area: row.dropoff_area,
      street: row.dropoff_street,
      building: row.dropoff_building,
      floor: row.dropoff_floor,
      apartment: row.dropoff_apartment,
      landmark: row.dropoff_landmark,
    },
    codItemsAmount: Money.of(row.cod_items_amount),
    carriesDeliveryFee: row.carries_delivery_fee,
    codFeeAmount: Money.of(row.cod_fee_amount),
    codCollectedAmount: row.cod_collected_amount === null ? null : Money.of(row.cod_collected_amount),
    attemptCount: row.attempt_count,
    assignedAt: row.assigned_at,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    returnedAt: row.returned_at,
    sellerOrderCancelledAt: row.seller_order_cancelled_at,
    createdAt: row.created_at,
  };
}

/** A shipment as the `seller_order.ready_for_pickup` snapshot describes it (spec 11 UC-DE-1, D-2). */
export interface NewShipment {
  sellerOrderId: string;
  orderId: string;
  orderNumber: string;
  paymentMethod: ShipmentPaymentMethod;
  orderDeliveryFee: Money;
  codItemsAmount: Money;
  pickup: ShipmentPickup;
  dropoff: ShipmentDropoff;
}

/** What a transition writes besides the status (only the fields it sets). */
export interface ShipmentChange {
  status: ShipmentStatus;
  agentId?: string;
  assignedAt?: Date;
  pickedUpAt?: Date;
  deliveredAt?: Date;
  returnedAt?: Date;
  sellerOrderCancelledAt?: Date;
  attemptCount?: number;
  codCollectedAmount?: Money;
  codItemsAmount?: Money;
  /** The COD fee carrier (DE-8): set with the fee, or released with 0. */
  feeCarrier?: { carries: boolean; feeAmount: Money };
}

@injectable()
export class ShipmentRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /**
   * Creates the delivery `unassigned` unless the seller order already has one (replay-safe,
   * uq_shipments_seller_order_id_delivery). Returns it, or null when it existed.
   */
  async insertIfNew(shipment: NewShipment, trx: DbTransaction): Promise<Shipment | null> {
    const [row] = await trx<ShipmentTable>(T)
      .insert({
        kind: ShipmentKind.DELIVERY,
        return_id: null,
        seller_order_id: shipment.sellerOrderId,
        order_id: shipment.orderId,
        agent_id: null,
        status: ShipmentStatus.UNASSIGNED,
        order_number: shipment.orderNumber,
        payment_method: shipment.paymentMethod,
        order_delivery_fee: shipment.orderDeliveryFee.toString(),
        pickup_business_name: shipment.pickup.businessName,
        pickup_governorate_id: shipment.pickup.governorateId,
        pickup_phone: shipment.pickup.phone,
        pickup_city: shipment.pickup.city,
        pickup_area: shipment.pickup.area,
        pickup_street: shipment.pickup.street,
        pickup_building: shipment.pickup.building,
        pickup_landmark: shipment.pickup.landmark,
        dropoff_recipient_name: shipment.dropoff.recipientName,
        dropoff_recipient_phone: shipment.dropoff.recipientPhone,
        dropoff_governorate_id: shipment.dropoff.governorateId,
        dropoff_governorate_name: shipment.dropoff.governorateName,
        dropoff_city: shipment.dropoff.city,
        dropoff_area: shipment.dropoff.area,
        dropoff_street: shipment.dropoff.street,
        dropoff_building: shipment.dropoff.building,
        dropoff_floor: shipment.dropoff.floor,
        dropoff_apartment: shipment.dropoff.apartment,
        dropoff_landmark: shipment.dropoff.landmark,
        cod_items_amount: shipment.codItemsAmount.toString(),
        carries_delivery_fee: false,
        cod_fee_amount: Money.zero().toString(),
        cod_collected_amount: null,
        attempt_count: 0,
        assigned_at: null,
        picked_up_at: null,
        delivered_at: null,
        returned_at: null,
        seller_order_cancelled_at: null,
      })
      // The conflict target names the partial index's predicate, so Postgres can infer it.
      .onConflict(trx.raw('(seller_order_id) WHERE kind = ?', [ShipmentKind.DELIVERY]))
      .ignore()
      .returning<ShipmentRow[]>(COLUMNS);
    return row ? toModel(row) : null;
  }

  async findById(id: string, trx?: DbTransaction): Promise<Shipment | null> {
    const row = await this.exec(trx)<ShipmentTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .first<ShipmentRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** Locks a shipment (`FOR UPDATE`); with `skipLocked` a busy one returns null (the retry job). */
  async lockById(
    id: string,
    trx: DbTransaction,
    options: { skipLocked?: boolean } = {},
  ): Promise<Shipment | null> {
    const qb = trx<ShipmentTable>(T)
      .select(...COLUMNS)
      .where({ id });
    void (options.skipLocked ? qb.forUpdate().skipLocked() : qb.forUpdate());
    const row = await qb.first<ShipmentRow | undefined>();
    return row ? toModel(row) : null;
  }

  /**
   * The seller order's delivery, unlocked: finds the checkout to lock
   * (uq_shipments_seller_order_id_delivery). Return shipments of the seller order are left out.
   */
  async findBySellerOrderId(sellerOrderId: string, trx?: DbTransaction): Promise<Shipment | null> {
    const row = await this.exec(trx)<ShipmentTable>(T)
      .select(...COLUMNS)
      .where({ seller_order_id: sellerOrderId, kind: ShipmentKind.DELIVERY })
      .first<ShipmentRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** Locks the seller order's delivery, if it exists yet (the seller-order consumer). */
  async lockBySellerOrderId(sellerOrderId: string, trx: DbTransaction): Promise<Shipment | null> {
    const row = await trx<ShipmentTable>(T)
      .select(...COLUMNS)
      .where({ seller_order_id: sellerOrderId, kind: ShipmentKind.DELIVERY })
      .forUpdate()
      .first<ShipmentRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** Locks every shipment of a checkout, in id order (the fee carrier, DE-7, DE-8). */
  async lockByOrderId(orderId: string, trx: DbTransaction): Promise<Shipment[]> {
    const rows = await trx<ShipmentTable>(T)
      .select(...COLUMNS)
      .where({ order_id: orderId })
      .orderBy('id')
      .forUpdate();
    return rows.map(toModel);
  }

  /**
   * Conditional transition (spec 11 §1.1): applies only if the status is still one of `from`.
   * Returns the shipment after the change, or null when it had moved on.
   */
  async transition(
    id: string,
    from: readonly ShipmentStatus[],
    change: ShipmentChange,
    trx: DbTransaction,
  ): Promise<Shipment | null> {
    const [row] = await trx<ShipmentTable>(T)
      .update({
        status: change.status,
        ...(change.agentId !== undefined ? { agent_id: change.agentId } : {}),
        ...(change.assignedAt ? { assigned_at: change.assignedAt } : {}),
        ...(change.pickedUpAt ? { picked_up_at: change.pickedUpAt } : {}),
        ...(change.deliveredAt ? { delivered_at: change.deliveredAt } : {}),
        ...(change.returnedAt ? { returned_at: change.returnedAt } : {}),
        ...(change.sellerOrderCancelledAt
          ? { seller_order_cancelled_at: change.sellerOrderCancelledAt }
          : {}),
        ...(change.attemptCount !== undefined ? { attempt_count: change.attemptCount } : {}),
        ...(change.codCollectedAmount ? { cod_collected_amount: change.codCollectedAmount.toString() } : {}),
        ...(change.codItemsAmount ? { cod_items_amount: change.codItemsAmount.toString() } : {}),
        ...(change.feeCarrier
          ? {
              carries_delivery_fee: change.feeCarrier.carries,
              cod_fee_amount: change.feeCarrier.feeAmount.toString(),
            }
          : {}),
        updated_at: trx.fn.now(),
      })
      .where({ id })
      .whereIn('status', [...from])
      .returning<ShipmentRow[]>(COLUMNS);
    return row ? toModel(row) : null;
  }

  /** The retry job's candidates, oldest first, read without locks: idx_shipments_created_at_id (DE-9). */
  async findUnassignedIds(limit: number): Promise<string[]> {
    const rows = await this.db
      .knex<ShipmentTable>(T)
      .select('id')
      .where({ status: ShipmentStatus.UNASSIGNED })
      .orderBy([{ column: 'created_at' }, { column: 'id' }])
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /**
   * The agent's list, keyset page: idx_shipments_agent_id_created_at_id (D-10). Without a status
   * filter only the active statuses (DE-12).
   */
  async listForAgent(agentId: string, query: ParsedListQuery, trx?: DbTransaction): Promise<Shipment[]> {
    const qb = this.exec(trx)<ShipmentTable>(T)
      .select(...COLUMNS)
      .where({ agent_id: agentId });
    if (!query.filters.some((filter) => filter.field === 'status')) {
      void qb.whereIn('status', [...ACTIVE_SHIPMENT_STATUSES]);
    }
    const rows = (await applyListQuery(qb, query, 'id')) as ShipmentRow[];
    return rows.map(toModel);
  }

  /** Admin list, keyset page (`limit + 1` rows): D-3 / D-10 indexes. */
  async list(query: ParsedListQuery, trx?: DbTransaction): Promise<Shipment[]> {
    const qb = this.exec(trx)<ShipmentTable>(T).select(...COLUMNS);
    const rows = (await applyListQuery(qb, query, 'id')) as ShipmentRow[];
    return rows.map(toModel);
  }

  /** Dashboard counts (spec 20 §3.2), served by `idx_shipments_status_created_at_id`. Absent statuses are left out. */
  async countByStatuses(statuses: readonly ShipmentStatus[]): Promise<Map<ShipmentStatus, number>> {
    const rows = await this.db
      .knex(T)
      .select('status')
      .count<{ status: ShipmentStatus; count: string }[]>('* as count')
      .whereIn('status', statuses)
      .groupBy('status');
    return new Map(rows.map((row) => [row.status, Number(row.count)]));
  }
}
