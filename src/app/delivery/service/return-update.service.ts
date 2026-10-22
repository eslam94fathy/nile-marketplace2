import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type EventEnvelope,
  PermanentEventError,
  ReturnApproved,
  ReturnStatusChanged,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { DeliveryActorRole, ShipmentStatus } from '../enums';
import { type ShipmentDropoff, type ShipmentPickup } from '../model/shipment.model';
import { type ShipmentHistoryRepository } from '../repository/shipment-history.repository';
import { type NewReturnShipment, type ShipmentRepository } from '../repository/shipment.repository';
import { PayloadReader } from './seller-order-update.service';
import { type ShipmentAssignmentService } from './shipment-assignment.service';

/** No agent holds the parcel yet: a cancelled return cancels its shipment (UC-DE-10). */
const CANCELLABLE: readonly ShipmentStatus[] = [
  ShipmentStatus.UNASSIGNED,
  ShipmentStatus.ASSIGNED,
  ShipmentStatus.PICKUP_FAILED,
];
/** The return statuses of spec 18 §1.1 that matter here. */
const CANCELLED = 'cancelled';
const APPROVED = 'approved';

/**
 * The `delivery.return-updates` consumer (spec 11 UC-DE-8, UC-DE-10, DE-24), inside the host's
 * transaction. `return.approved` creates the return shipment (replay-safe) and auto-assigns it;
 * `return.status_changed` to `cancelled` cancels it. Any other status change is not delivery's.
 */
@injectable()
export class ReturnUpdateService {
  constructor(
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.ShipmentRepository) private readonly shipments: ShipmentRepository,
    @inject(TOKENS.ShipmentHistoryRepository) private readonly history: ShipmentHistoryRepository,
    @inject(TOKENS.ShipmentAssignmentService) private readonly assignment: ShipmentAssignmentService,
  ) {}

  async handle(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    switch (envelope.eventType) {
      case ReturnApproved.type:
        return this.create(envelope, trx);
      case ReturnStatusChanged.type:
        return this.statusChanged(envelope, trx);
    }
    throw new PermanentEventError(`delivery.return-updates does not handle ${envelope.eventType}`);
  }

  /** UC-DE-8. A replay finds the shipment already there and changes nothing. */
  private async create(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const shipment = await this.shipments.insertReturnIfNew(returnShipment(envelope), trx);
    if (!shipment) {
      this.logger.info('return shipment already created', {
        event: 'RETURN_SHIPMENT_ALREADY_CREATED',
        returnId: envelope.payload.returnId,
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
    this.logger.info('return shipment created', {
      event: 'RETURN_SHIPMENT_CREATED',
      shipmentId: shipment.id,
      returnId: shipment.returnId,
    });
    await this.assignment.autoAssign(shipment, trx);
  }

  /** UC-DE-10, DE-24. */
  private async statusChanged(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const read = new PayloadReader(envelope);
    if (read.string(envelope.payload, 'to') !== CANCELLED) return;
    const returnId = read.uuid(envelope.payload, 'returnId');
    const shipment = await this.shipments.lockByReturnId(returnId, trx);
    if (!shipment) {
      // Approved but return.approved not applied yet: retried. Cancelled before approval: none coming.
      if (read.nullableString(envelope.payload, 'from') === APPROVED) {
        throw new ReturnEventTooEarlyError(
          `the cancel of return ${returnId} arrived before its shipment exists`,
        );
      }
      return;
    }
    if (!CANCELLABLE.includes(shipment.status)) {
      this.logger.warn('return cancelled after its shipment left the cancellable states', {
        event: 'RETURN_CANCEL_IGNORED',
        shipmentId: shipment.id,
        returnId,
        status: shipment.status,
      });
      return;
    }
    const next = await this.shipments.transition(
      shipment.id,
      CANCELLABLE,
      { status: ShipmentStatus.CANCELLED },
      trx,
    );
    if (!next) throw new Error(`shipment ${shipment.id} changed under its lock`);
    await this.history.add(
      {
        shipmentId: shipment.id,
        fromStatus: shipment.status,
        toStatus: ShipmentStatus.CANCELLED,
        actorRole: DeliveryActorRole.SYSTEM,
        actorUserId: null,
        reason: 'return_cancelled',
      },
      trx,
    );
    this.logger.info('return shipment cancelled with its return', {
      event: 'RETURN_SHIPMENT_CANCELLED',
      shipmentId: shipment.id,
      returnId,
    });
  }
}

/** A cancel that overtook the approval creating its shipment: thrown so the broker retries it. */
export class ReturnEventTooEarlyError extends Error {
  override readonly name = 'ReturnEventTooEarlyError';
}

/**
 * The return shipment the payload describes, by party (DE-21): the event's `dropoff` (the seller) goes
 * in the pickup columns, its `pickup` (the customer) in the drop-off ones. A malformed payload goes to
 * the DLQ (PermanentEventError).
 */
export function returnShipment(envelope: EventEnvelope): NewReturnShipment {
  const read = new PayloadReader(envelope);
  const p = read.record(envelope.payload, 'payload');
  const customer = read.record(p.pickup, 'pickup');
  const seller = read.record(p.dropoff, 'dropoff');
  const paymentMethod = read.string(p, 'paymentMethod');
  if (paymentMethod !== 'cod' && paymentMethod !== 'kashier') {
    throw new PermanentEventError(`${envelope.eventType}: payload.paymentMethod is not cod or kashier`);
  }
  const sellerSide: ShipmentPickup = {
    businessName: read.string(seller, 'businessName'),
    phone: read.string(seller, 'phone'),
    governorateId: read.uuid(seller, 'governorateId'),
    city: read.string(seller, 'city'),
    area: read.string(seller, 'area'),
    street: read.string(seller, 'street'),
    building: read.string(seller, 'building'),
    landmark: read.nullableString(seller, 'landmark'),
  };
  const customerSide: ShipmentDropoff = {
    recipientName: read.string(customer, 'recipientName'),
    recipientPhone: read.string(customer, 'recipientPhone'),
    governorateId: read.uuid(customer, 'governorateId'),
    governorateName: read.string(customer, 'governorateName'),
    city: read.string(customer, 'city'),
    area: read.string(customer, 'area'),
    street: read.string(customer, 'street'),
    building: read.string(customer, 'building'),
    floor: read.nullableString(customer, 'floor'),
    apartment: read.nullableString(customer, 'apartment'),
    landmark: read.nullableString(customer, 'landmark'),
  };
  return {
    returnId: read.uuid(p, 'returnId'),
    sellerOrderId: read.uuid(p, 'sellerOrderId'),
    orderId: read.uuid(p, 'orderId'),
    orderNumber: read.string(p, 'orderNumber'),
    paymentMethod,
    pickup: sellerSide,
    dropoff: customerSide,
  };
}
