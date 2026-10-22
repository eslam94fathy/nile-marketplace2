import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type EventEnvelope,
  PermanentEventError,
  ReturnShipmentDelivered,
  ReturnShipmentFailed,
  ReturnShipmentPickedUp,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { addDuration, TimeUnit } from '../../../pkg/time';
import { ReturnActorRole, ReturnStatus } from '../enums';
import { type ReturnActor, type ReturnRequest } from '../model/return-request.model';
import { type ReturnRequestRepository } from '../repository/return-request.repository';
import { type ReturnLifecycleService } from './return-lifecycle.service';

/** Delivery events carry the agent's profile id, not a user id (as the order histories). */
const AGENT: ReturnActor = { role: ReturnActorRole.DELIVERY_AGENT, userId: null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `returns.shipment-updates` consumer (spec 18 UC-RE-6), inside the host's transaction. An event
 * that overtook its predecessor is retried; a stale one is a `warn` no-op (the OR-14 rule). A pickup or
 * hand-over that lands after the customer cancelled is an `error` for an admin (RE-24).
 */
@injectable()
export class ReturnShipmentUpdateService {
  constructor(
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'RETURN_INSPECTION_HOURS'>,
    @inject(TOKENS.ReturnLifecycleService) private readonly lifecycle: ReturnLifecycleService,
    @inject(TOKENS.ReturnRequestRepository) private readonly requests: ReturnRequestRepository,
  ) {}

  async handle(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const returnId = uuidOf(envelope, 'returnId');
    const agentId = uuidOf(envelope, 'agentId');
    const found = await this.requests.findById(returnId, {}, trx);
    if (!found) throw new PermanentEventError(`${envelope.eventType}: return ${returnId} does not exist`);
    // The order number is ordering's: read before the lock (spec 18 §5).
    const orderNumber = await this.lifecycle.orderNumberOf(found.orderId);
    const locked = await this.requests.lockById(returnId, trx);
    if (!locked) throw new Error(`return ${returnId} vanished`);

    switch (envelope.eventType) {
      case ReturnShipmentPickedUp.type:
        if (locked.status !== ReturnStatus.APPROVED) return this.notApplied(envelope, locked);
        await this.lifecycle.transition(
          locked,
          [ReturnStatus.APPROVED],
          { status: ReturnStatus.PICKED_UP, agentId },
          AGENT,
          null,
          orderNumber,
          trx,
        );
        return;
      case ReturnShipmentDelivered.type:
        if (locked.status === ReturnStatus.APPROVED) {
          throw new ReturnShipmentEventTooEarlyError(
            `${envelope.eventType} for return ${returnId} arrived before its pickup`,
          );
        }
        if (locked.status !== ReturnStatus.PICKED_UP) return this.notApplied(envelope, locked);
        await this.lifecycle.transition(
          locked,
          [ReturnStatus.PICKED_UP],
          {
            status: ReturnStatus.RECEIVED,
            receivedAt: this.clock.now(),
            inspectionDeadlineAt: addDuration(
              this.clock.now(),
              this.env.RETURN_INSPECTION_HOURS,
              TimeUnit.HOUR,
            ),
          },
          AGENT,
          null,
          orderNumber,
          trx,
        );
        return;
      case ReturnShipmentFailed.type:
        if (locked.status === ReturnStatus.CANCELLED) return;
        if (locked.status !== ReturnStatus.APPROVED) return this.notApplied(envelope, locked);
        // Nothing moved and no fee is charged (DE-18); the request ends here.
        await this.lifecycle.transition(
          locked,
          [ReturnStatus.APPROVED],
          { status: ReturnStatus.PICKUP_FAILED, clearRefundPayout: true },
          AGENT,
          null,
          orderNumber,
          trx,
        );
        return;
    }
    throw new PermanentEventError(`returns.shipment-updates does not handle ${envelope.eventType}`);
  }

  private notApplied(envelope: EventEnvelope, request: ReturnRequest): void {
    if (request.status === ReturnStatus.CANCELLED) {
      this.logger.error('the return parcel moved after the customer cancelled the return', {
        event: 'RETURN_PICKED_UP_AFTER_CANCEL',
        eventType: envelope.eventType,
        returnId: request.id,
        shipmentId: envelope.payload.shipmentId,
      });
      return;
    }
    this.logger.warn('return shipment event ignored for the return state', {
      event: 'RETURN_SHIPMENT_EVENT_IGNORED',
      eventType: envelope.eventType,
      returnId: request.id,
      status: request.status,
    });
  }
}

/** A shipment event that overtook its predecessor: thrown so the broker retries it. */
export class ReturnShipmentEventTooEarlyError extends Error {
  override readonly name = 'ReturnShipmentEventTooEarlyError';
}

function uuidOf(envelope: EventEnvelope, field: string): string {
  const value = envelope.payload[field];
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new PermanentEventError(`${envelope.eventType}: payload.${field} must be a UUID`);
  }
  return value;
}
