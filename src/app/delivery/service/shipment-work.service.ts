import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type IOutbox,
  ShipmentAttemptFailed,
  ShipmentDelivered,
  ShipmentOutForDelivery,
  ShipmentPickedUp,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { Money } from '../../../lib/money';
import { type AttemptFailureReason, DeliveryActorRole, ShipmentStatus } from '../enums';
import { shipmentInvalidStatusTransition, shipmentNotFound } from '../errors';
import { type DeliveryAgent } from '../model/delivery-agent.model';
import {
  afterFailedAttempt,
  collectedAmountFor,
  deliveryFeeLeftUncollected,
  type Shipment,
  takesDeliveryFee,
  toAttemptNumber,
} from '../model/shipment.model';
import { type ShipmentHistoryRepository } from '../repository/shipment-history.repository';
import { type ShipmentChange, type ShipmentRepository } from '../repository/shipment.repository';

const S = ShipmentStatus;

/** A locked shipment with every shipment of its checkout, locked in id order (DE-7). */
interface LockedCheckout {
  shipment: Shipment;
  checkout: Shipment[];
}

/**
 * The agent works its shipments (spec 11 UC-DE-3, DE-6). Ownership: another agent's shipment is
 * `404`. Out for delivery, delivered and failed attempts lock the whole checkout, because they
 * take, keep or release the COD fee (DE-8); picked up and the confirmed return lock one shipment.
 */
@injectable()
export class ShipmentWorkService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.ShipmentRepository) private readonly shipments: ShipmentRepository,
    @inject(TOKENS.ShipmentHistoryRepository) private readonly history: ShipmentHistoryRepository,
  ) {}

  async pickedUp(agent: DeliveryAgent, shipmentId: string): Promise<Shipment> {
    return this.tx.run(async (trx) => {
      const shipment = await this.lockOwn(agent, shipmentId, trx);
      const now = this.clock.now();
      const next = await this.move(
        agent,
        shipment,
        [S.ASSIGNED],
        { status: S.PICKED_UP, pickedUpAt: now },
        null,
        trx,
      );
      await this.outbox.add(trx, {
        contract: ShipmentPickedUp,
        aggregateId: next.id,
        payload: { ...this.refs(next, agent), pickedUpAt: now.toISOString() },
      });
      return next;
    });
  }

  async outForDelivery(agent: DeliveryAgent, shipmentId: string): Promise<Shipment> {
    return this.tx.run(async (trx) => {
      const { shipment, checkout } = await this.lockOwnCheckout(agent, shipmentId, trx);
      const change: ShipmentChange = { status: S.OUT_FOR_DELIVERY };
      if (takesDeliveryFee(shipment, checkout)) {
        change.feeCarrier = { carries: true, feeAmount: shipment.orderDeliveryFee };
      }
      const next = await this.move(agent, shipment, [S.PICKED_UP, S.DELIVERY_FAILED], change, null, trx);
      await this.outbox.add(trx, {
        contract: ShipmentOutForDelivery,
        aggregateId: next.id,
        payload: { ...this.refs(next, agent), attemptNumber: toAttemptNumber(next.attemptCount + 1) },
      });
      return next;
    });
  }

  async delivered(agent: DeliveryAgent, shipmentId: string, given: Money | undefined): Promise<Shipment> {
    return this.tx.run(async (trx) => {
      const { shipment, checkout } = await this.lockOwnCheckout(agent, shipmentId, trx);
      this.requireStatus(shipment, [S.OUT_FOR_DELIVERY]);
      const collected = collectedAmountFor(shipment, given);
      const now = this.clock.now();
      const next = await this.move(
        agent,
        shipment,
        [S.OUT_FOR_DELIVERY],
        { status: S.DELIVERED, deliveredAt: now, ...(collected ? { codCollectedAmount: collected } : {}) },
        null,
        trx,
      );
      await this.outbox.add(trx, {
        contract: ShipmentDelivered,
        aggregateId: next.id,
        payload: {
          ...this.refs(next, agent),
          codCollectedAmount: collected?.toString() ?? null,
          deliveryFeeCollected: next.carriesDeliveryFee,
          deliveryFeeAmount: next.codFeeAmount.toString(),
          deliveredAt: now.toISOString(),
        },
      });
      this.warnIfFeeUncollected(checkout, next);
      return next;
    });
  }

  async failedAttempt(
    agent: DeliveryAgent,
    shipmentId: string,
    reason: AttemptFailureReason,
    note: string | null,
  ): Promise<Shipment> {
    return this.tx.run(async (trx) => {
      const { shipment, checkout } = await this.lockOwnCheckout(agent, shipmentId, trx);
      this.requireStatus(shipment, [S.OUT_FOR_DELIVERY]);
      const { attemptNumber, returning } = afterFailedAttempt(shipment.attemptCount, reason);
      const change: ShipmentChange = {
        status: returning ? S.RETURNING_TO_SELLER : S.DELIVERY_FAILED,
        attemptCount: attemptNumber,
      };
      // Released so the next shipment of the checkout going out takes it (DE-8).
      if (shipment.carriesDeliveryFee) change.feeCarrier = { carries: false, feeAmount: Money.zero() };
      const next = await this.move(agent, shipment, [S.OUT_FOR_DELIVERY], change, reason, trx);
      await this.history.addAttempt(
        { shipmentId: next.id, attemptNumber, reason, note, agentId: agent.id },
        trx,
      );
      await this.outbox.add(trx, {
        contract: ShipmentAttemptFailed,
        aggregateId: next.id,
        payload: { ...this.refs(next, agent), attemptNumber, reason, returningToSeller: returning },
      });
      if (returning) this.warnIfFeeUncollected(checkout, next);
      return next;
    });
  }

  /** DE-6: the seller took back a parcel whose seller order was cancelled after pickup. */
  async returned(agent: DeliveryAgent, shipmentId: string): Promise<Shipment> {
    return this.tx.run(async (trx) => {
      const shipment = await this.lockOwn(agent, shipmentId, trx);
      if (shipment.sellerOrderCancelledAt === null) throw shipmentInvalidStatusTransition(shipment.status);
      return this.move(
        agent,
        shipment,
        [S.RETURNING_TO_SELLER],
        { status: S.RETURNED_TO_SELLER, returnedAt: this.clock.now() },
        null,
        trx,
      );
    });
  }

  private async lockOwn(agent: DeliveryAgent, shipmentId: string, trx: DbTransaction): Promise<Shipment> {
    const shipment = await this.shipments.lockById(shipmentId, trx);
    if (!shipment || shipment.agentId !== agent.id) throw shipmentNotFound();
    return shipment;
  }

  /** The order id comes from an unlocked read; ownership is checked again under the lock. */
  private async lockOwnCheckout(
    agent: DeliveryAgent,
    shipmentId: string,
    trx: DbTransaction,
  ): Promise<LockedCheckout> {
    const peek = await this.shipments.findById(shipmentId, trx);
    if (!peek || peek.agentId !== agent.id) throw shipmentNotFound();
    const checkout = await this.shipments.lockByOrderId(peek.orderId, trx);
    const shipment = checkout.find((s) => s.id === shipmentId);
    if (!shipment || shipment.agentId !== agent.id) throw shipmentNotFound();
    return { shipment, checkout };
  }

  private requireStatus(shipment: Shipment, from: readonly ShipmentStatus[]): void {
    if (!from.includes(shipment.status)) throw shipmentInvalidStatusTransition(shipment.status);
  }

  /** Conditional transition + history row, on a shipment the caller holds locked. */
  private async move(
    agent: DeliveryAgent,
    shipment: Shipment,
    from: readonly ShipmentStatus[],
    change: ShipmentChange,
    reason: string | null,
    trx: DbTransaction,
  ): Promise<Shipment> {
    this.requireStatus(shipment, from);
    const next = await this.shipments.transition(shipment.id, from, change, trx);
    if (!next) throw new Error(`shipment ${shipment.id} changed under its lock`);
    await this.history.add(
      {
        shipmentId: shipment.id,
        fromStatus: shipment.status,
        toStatus: next.status,
        actorRole: DeliveryActorRole.DELIVERY_AGENT,
        actorUserId: agent.userId,
        reason,
      },
      trx,
    );
    this.logger.info('shipment status changed', {
      event: 'SHIPMENT_STATUS_CHANGED',
      shipmentId: shipment.id,
      agentId: agent.id,
      from: shipment.status,
      to: next.status,
    });
    return next;
  }

  private refs(shipment: Shipment, agent: DeliveryAgent) {
    return {
      shipmentId: shipment.id,
      sellerOrderId: shipment.sellerOrderId,
      orderId: shipment.orderId,
      agentId: agent.id,
    };
  }

  /** S-3: logged only; the ledger books the fee actually collected (spec 12). */
  private warnIfFeeUncollected(checkout: readonly Shipment[], changed: Shipment): void {
    const after = checkout.map((s) => (s.id === changed.id ? changed : s));
    if (!deliveryFeeLeftUncollected(after)) return;
    this.logger.warn('the checkout had a COD delivery but its delivery fee was not collected', {
      event: 'COD_DELIVERY_FEE_UNCOLLECTED',
      orderId: changed.orderId,
      shipmentId: changed.id,
      deliveryFee: changed.orderDeliveryFee.toString(),
    });
  }
}
