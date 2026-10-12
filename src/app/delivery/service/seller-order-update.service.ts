import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type EventEnvelope, PermanentEventError, SellerOrderReadyForPickup } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { Money } from '../../../lib/money';
import { DeliveryActorRole, ShipmentStatus } from '../enums';
import { type ShipmentDropoff, type ShipmentPickup } from '../model/shipment.model';
import { type ShipmentHistoryRepository } from '../repository/shipment-history.repository';
import { type NewShipment, type ShipmentRepository } from '../repository/shipment.repository';
import { type ShipmentAssignmentService } from './shipment-assignment.service';

/**
 * The `delivery.seller-order-updates` consumer (spec 11 UC-DE-1, UC-DE-5), inside the host's
 * transaction. `seller_order.ready_for_pickup` creates the shipment from the event's snapshot
 * (replay-safe) and auto-assigns it; the cancellation and return events follow in UC-DE-5.
 */
@injectable()
export class SellerOrderUpdateService {
  constructor(
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.ShipmentRepository) private readonly shipments: ShipmentRepository,
    @inject(TOKENS.ShipmentHistoryRepository) private readonly history: ShipmentHistoryRepository,
    @inject(TOKENS.ShipmentAssignmentService) private readonly assignment: ShipmentAssignmentService,
  ) {}

  async handle(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    if (envelope.eventType === SellerOrderReadyForPickup.type) return this.create(envelope, trx);
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
}

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
