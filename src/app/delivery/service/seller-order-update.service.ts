import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IClock } from '../../../lib/clock';
import {
  type EventEnvelope,
  PermanentEventError,
  SellerOrderCancelled,
  SellerOrderItemsCancelled,
  SellerOrderReadyForPickup,
  SellerOrderReturned,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { Money } from '../../../lib/money';
import { DeliveryActorRole, ShipmentStatus } from '../enums';
import {
  deliveryFeeLeftUncollected,
  type Shipment,
  type ShipmentDropoff,
  type ShipmentPickup,
} from '../model/shipment.model';
import { type ShipmentHistoryRepository } from '../repository/shipment-history.repository';
import {
  type NewShipment,
  type ShipmentChange,
  type ShipmentRepository,
} from '../repository/shipment.repository';
import { type ShipmentAssignmentService } from './shipment-assignment.service';

/**
 * The `delivery.seller-order-updates` consumer (spec 11 UC-DE-1, UC-DE-5), inside the host's
 * transaction. `seller_order.ready_for_pickup` creates the shipment from the event's snapshot
 * (replay-safe) and auto-assigns it; cancellations and returns follow the seller order (UC-DE-5,
 * DE-10, DE-15, DE-16). An event whose shipment should exist but doesn't yet is retried; a stale
 * one is a `warn` no-op.
 */
@injectable()
export class SellerOrderUpdateService {
  constructor(
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.ShipmentRepository) private readonly shipments: ShipmentRepository,
    @inject(TOKENS.ShipmentHistoryRepository) private readonly history: ShipmentHistoryRepository,
    @inject(TOKENS.ShipmentAssignmentService) private readonly assignment: ShipmentAssignmentService,
  ) {}

  async handle(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    switch (envelope.eventType) {
      case SellerOrderReadyForPickup.type:
        return this.create(envelope, trx);
      case SellerOrderItemsCancelled.type:
        return this.itemsCancelled(envelope, trx);
      case SellerOrderCancelled.type:
        return this.cancelled(envelope, trx);
      case SellerOrderReturned.type:
        return this.returned(envelope, trx);
    }
    throw new PermanentEventError(`delivery.seller-order-updates does not handle ${envelope.eventType}`);
  }

  /** UC-DE-1. A replay finds the shipment already there and changes nothing. */
  private async create(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const shipment = await this.shipments.insertIfNew(readyForPickupShipment(envelope), trx);
    if (!shipment) {
      this.logger.info('shipment already created for this seller order', {
        event: 'SHIPMENT_ALREADY_CREATED',
        sellerOrderId: envelope.payload.sellerOrderId,
      });
      return;
    }
    await this.history.add(
      {
        shipmentId: shipment.id,
        fromStatus: null,
        toStatus: ShipmentStatus.UNASSIGNED,
        actorRole: DeliveryActorRole.SYSTEM,
        actorUserId: null,
        reason: null,
      },
      trx,
    );
    this.logger.info('shipment created', {
      event: 'SHIPMENT_CREATED',
      shipmentId: shipment.id,
      orderId: shipment.orderId,
    });
    await this.assignment.autoAssign(shipment, trx);
  }

  /**
   * DE-15: the COD amount follows what the customer still pays for the seller order's items, which only
   * goes down: `newPaidSubtotal` (after its coupon share, spec 09 §8.8). An event from before coupons has
   * only `newSubtotal`, which is the same amount without a coupon.
   */
  private async itemsCancelled(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const read = new PayloadReader(envelope);
    const sellerOrderId = read.uuid(envelope.payload, 'sellerOrderId');
    const previousStatus = read.string(envelope.payload, 'previousStatus');
    const newSubtotal = read.money(
      envelope.payload,
      envelope.payload.newPaidSubtotal === undefined ? 'newSubtotal' : 'newPaidSubtotal',
    );
    const shipment = await this.shipments.lockBySellerOrderId(sellerOrderId, trx);
    if (!shipment) return this.noShipmentYet(envelope, sellerOrderId, previousStatus);
    if (shipment.paymentMethod !== 'cod') return;
    if (!BEFORE_PICKUP.includes(shipment.status)) {
      return this.ignore(envelope, shipment, 'items cancelled after the parcel was picked up');
    }
    if (!newSubtotal.lessThan(shipment.codItemsAmount)) {
      return this.ignore(envelope, shipment, 'an older item cancellation');
    }
    await this.change(shipment, BEFORE_PICKUP, { status: shipment.status, codItemsAmount: newSubtotal }, trx);
    this.logger.info('shipment COD amount lowered', {
      event: 'SHIPMENT_COD_AMOUNT_CHANGED',
      shipmentId: shipment.id,
      codItemsAmount: newSubtotal.toString(),
    });
  }

  /**
   * UC-DE-5: before pickup the shipment is cancelled; after pickup it goes back to the seller, the
   * fee is released and the agent confirms the return (DE-6). The checkout is locked (DE-7, DE-16).
   */
  private async cancelled(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const read = new PayloadReader(envelope);
    const sellerOrderId = read.uuid(envelope.payload, 'sellerOrderId');
    const previousStatus = read.string(envelope.payload, 'previousStatus');
    const reason = read.string(envelope.payload, 'reason');
    const peek = await this.shipments.findBySellerOrderId(sellerOrderId, trx);
    if (!peek) return this.noShipmentYet(envelope, sellerOrderId, previousStatus);
    const checkout = await this.shipments.lockByOrderId(peek.orderId, trx);
    const shipment = checkout.find((s) => s.id === peek.id);
    if (!shipment) throw new Error(`shipment ${peek.id} vanished under its lock`);

    if (BEFORE_PICKUP.includes(shipment.status)) {
      await this.change(shipment, BEFORE_PICKUP, { status: ShipmentStatus.CANCELLED }, trx, reason);
      this.logger.info('shipment cancelled with its seller order', {
        event: 'SHIPMENT_CANCELLED',
        shipmentId: shipment.id,
      });
      return;
    }
    if (!WITH_AGENT.includes(shipment.status)) {
      return this.ignore(envelope, shipment, 'the shipment is already finished or on its way back');
    }
    const change: ShipmentChange = {
      status: ShipmentStatus.RETURNING_TO_SELLER,
      sellerOrderCancelledAt: this.clock.now(),
    };
    if (shipment.carriesDeliveryFee) change.feeCarrier = { carries: false, feeAmount: Money.zero() };
    const next = await this.change(shipment, WITH_AGENT, change, trx, reason);
    this.logger.warn('seller order cancelled after the agent picked the parcel up; it goes back', {
      event: 'SHIPMENT_CANCELLED_AFTER_PICKUP',
      shipmentId: shipment.id,
      agentId: shipment.agentId,
      from: shipment.status,
    });
    if (deliveryFeeLeftUncollected(checkout.map((s) => (s.id === next.id ? next : s)))) {
      this.logger.warn('the checkout had a COD delivery but its delivery fee was not collected', {
        event: 'COD_DELIVERY_FEE_UNCOLLECTED',
        orderId: next.orderId,
        shipmentId: next.id,
        deliveryFee: next.orderDeliveryFee.toString(),
      });
    }
  }

  /** UC-DE-5: the seller confirmed the parcel is back. The shipment always exists by now (DE-16). */
  private async returned(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const sellerOrderId = new PayloadReader(envelope).uuid(envelope.payload, 'sellerOrderId');
    const shipment = await this.shipments.lockBySellerOrderId(sellerOrderId, trx);
    if (!shipment) {
      throw new SellerOrderEventTooEarlyError(
        `${envelope.eventType} for seller order ${sellerOrderId} arrived before its shipment exists`,
      );
    }
    if (shipment.status !== ShipmentStatus.RETURNING_TO_SELLER) {
      return this.ignore(envelope, shipment, 'the shipment is not on its way back');
    }
    await this.change(
      shipment,
      [ShipmentStatus.RETURNING_TO_SELLER],
      { status: ShipmentStatus.RETURNED_TO_SELLER, returnedAt: this.clock.now() },
      trx,
    );
  }

  /** DE-10, DE-15: a shipment exists or is coming once the seller order was ready for pickup. */
  private noShipmentYet(envelope: EventEnvelope, sellerOrderId: string, previousStatus: string): void {
    if (previousStatus === READY_FOR_PICKUP) {
      throw new SellerOrderEventTooEarlyError(
        `${envelope.eventType} for seller order ${sellerOrderId} arrived before seller_order.ready_for_pickup`,
      );
    }
    this.logger.debug('no shipment for this seller order, none expected', {
      event: 'SELLER_ORDER_EVENT_NO_SHIPMENT',
      eventType: envelope.eventType,
      sellerOrderId,
      previousStatus,
    });
  }

  private ignore(envelope: EventEnvelope, shipment: Shipment, why: string): void {
    this.logger.warn('seller-order event ignored for the shipment state', {
      event: 'SELLER_ORDER_EVENT_IGNORED',
      eventType: envelope.eventType,
      shipmentId: shipment.id,
      status: shipment.status,
      why,
    });
  }

  /** Conditional transition + history row (system actor), on a shipment the caller holds locked. */
  private async change(
    shipment: Shipment,
    from: readonly ShipmentStatus[],
    change: ShipmentChange,
    trx: DbTransaction,
    reason: string | null = null,
  ): Promise<Shipment> {
    const next = await this.shipments.transition(shipment.id, from, change, trx);
    if (!next) throw new Error(`shipment ${shipment.id} changed under its lock`);
    if (next.status !== shipment.status) {
      await this.history.add(
        {
          shipmentId: shipment.id,
          fromStatus: shipment.status,
          toStatus: next.status,
          actorRole: DeliveryActorRole.SYSTEM,
          actorUserId: null,
          reason,
        },
        trx,
      );
    }
    return next;
  }
}

/** A seller-order event that overtook the event creating its shipment: thrown so the broker retries it. */
export class SellerOrderEventTooEarlyError extends Error {
  override readonly name = 'SellerOrderEventTooEarlyError';
}

/** The seller order's status that promises a shipment (spec 09 §1.1). */
const READY_FOR_PICKUP = 'ready_for_pickup';
/** No agent has the parcel yet: cancellable, and its COD amount can still change. */
const BEFORE_PICKUP: readonly ShipmentStatus[] = [ShipmentStatus.UNASSIGNED, ShipmentStatus.ASSIGNED];
/** The agent holds the parcel: a cancellation sends it back (UC-DE-5). */
const WITH_AGENT: readonly ShipmentStatus[] = [
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.DELIVERY_FAILED,
];

/** The shipment the snapshot describes; a payload that can't be read goes to the DLQ (PermanentEventError). */
export function readyForPickupShipment(envelope: EventEnvelope): NewShipment {
  const read = new PayloadReader(envelope);
  const p = read.record(envelope.payload, 'payload');
  const pickup = read.record(p.pickup, 'pickup');
  const dropoff = read.record(p.dropoff, 'dropoff');
  const paymentMethod = read.string(p, 'paymentMethod');
  if (paymentMethod !== 'cod' && paymentMethod !== 'kashier') {
    throw new PermanentEventError(`${envelope.eventType}: payload.paymentMethod is not cod or kashier`);
  }
  const shipmentPickup: ShipmentPickup = {
    businessName: read.string(pickup, 'businessName'),
    phone: read.string(pickup, 'phone'),
    governorateId: read.uuid(pickup, 'governorateId'),
    city: read.string(pickup, 'city'),
    area: read.string(pickup, 'area'),
    street: read.string(pickup, 'street'),
    building: read.string(pickup, 'building'),
    landmark: read.nullableString(pickup, 'landmark'),
  };
  const shipmentDropoff: ShipmentDropoff = {
    recipientName: read.string(dropoff, 'recipientName'),
    recipientPhone: read.string(dropoff, 'recipientPhone'),
    governorateId: read.uuid(dropoff, 'governorateId'),
    governorateName: read.string(dropoff, 'governorateName'),
    city: read.string(dropoff, 'city'),
    area: read.string(dropoff, 'area'),
    street: read.string(dropoff, 'street'),
    building: read.string(dropoff, 'building'),
    floor: read.nullableString(dropoff, 'floor'),
    apartment: read.nullableString(dropoff, 'apartment'),
    landmark: read.nullableString(dropoff, 'landmark'),
  };
  return {
    sellerOrderId: read.uuid(p, 'sellerOrderId'),
    orderId: read.uuid(p, 'orderId'),
    orderNumber: read.string(p, 'orderNumber'),
    paymentMethod,
    orderDeliveryFee: read.money(p, 'orderDeliveryFee'),
    codItemsAmount: read.money(p, 'codItemsAmount'),
    pickup: shipmentPickup,
    dropoff: shipmentDropoff,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads event payload fields; anything malformed is a permanent error (retries can't fix it). */
export class PayloadReader {
  constructor(private readonly envelope: EventEnvelope) {}

  private fail(field: string, what: string): never {
    throw new PermanentEventError(`${this.envelope.eventType}: payload.${field} must be ${what}`);
  }

  record(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) this.fail(field, 'an object');
    return value as Record<string, unknown>;
  }

  string(from: Record<string, unknown>, field: string): string {
    const value = from[field];
    if (typeof value !== 'string' || value.length === 0) this.fail(field, 'a non-empty string');
    return value;
  }

  nullableString(from: Record<string, unknown>, field: string): string | null {
    const value = from[field];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') this.fail(field, 'a string or null');
    return value;
  }

  uuid(from: Record<string, unknown>, field: string): string {
    const value = this.string(from, field);
    if (!UUID.test(value)) this.fail(field, 'a UUID');
    return value;
  }

  money(from: Record<string, unknown>, field: string): Money {
    const value = this.string(from, field);
    try {
      const money = Money.of(value);
      if (money.isNegative()) throw new RangeError('negative');
      return money;
    } catch {
      return this.fail(field, 'a non-negative money string');
    }
  }
}
