import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type EventEnvelope,
  type IOutbox,
  PermanentEventError,
  SellerOrderDelivered,
  ShipmentAttemptFailed,
  ShipmentDelivered,
  ShipmentOutForDelivery,
  ShipmentPickedUp,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { Money } from '../../../lib/money';
import { type IInventoryService } from '../../inventory';
import { PaymentMethod } from '../../payments';
import { ActorRole, SellerOrderStatus } from '../enums';
import { isTerminal } from '../model/order-status.model';
import { type SellerOrder } from '../model/order.model';
import { type OrderItemRepository } from '../repository/order-item.repository';
import { type SellerOrderTransition } from '../repository/seller-order.repository';
import { type Actor, type LockedOrder, type OrderLifecycleService } from './order-lifecycle.service';

const S = SellerOrderStatus;

/** The agent is known by its delivery profile id only, so history rows carry no user (spec 09 §3.6). */
const AGENT: Actor = { role: ActorRole.DELIVERY_AGENT, userId: null };

/**
 * Per shipment event: the statuses it moves a seller order from, and the statuses that mean an
 * earlier event of the same shipment hasn't been applied yet (OR-14). Such an early event is retried
 * by the broker instead of being dropped; anything else (cancelled, already past it) is a stale no-op.
 */
interface ShipmentRule {
  from: readonly SellerOrderStatus[];
  early: readonly SellerOrderStatus[];
}

const RULES: Readonly<Record<string, ShipmentRule>> = {
  [ShipmentPickedUp.type]: { from: [S.READY_FOR_PICKUP], early: [S.PLACED, S.ACCEPTED] },
  [ShipmentOutForDelivery.type]: {
    from: [S.PICKED_UP, S.DELIVERY_FAILED],
    early: [S.READY_FOR_PICKUP, S.OUT_FOR_DELIVERY],
  },
  [ShipmentAttemptFailed.type]: {
    from: [S.OUT_FOR_DELIVERY],
    early: [S.READY_FOR_PICKUP, S.PICKED_UP, S.DELIVERY_FAILED],
  },
  [ShipmentDelivered.type]: {
    from: [S.OUT_FOR_DELIVERY],
    early: [S.READY_FOR_PICKUP, S.PICKED_UP, S.DELIVERY_FAILED],
  },
};

/** Thrown (and retried with backoff) when a shipment event overtook its predecessor. */
export class ShipmentEventTooEarlyError extends Error {
  override readonly name = 'ShipmentEventTooEarlyError';
}

/**
 * The `ordering.shipment-updates` consumer (spec 09 UC-OR-6, UC-OR-8), inside the host's transaction
 * (architecture §3.2): moves the seller order with the parcel, and on delivery commits its stock,
 * computes the agent's fee share and publishes `seller_order.delivered`, then re-derives (and maybe
 * closes) the order. State-machine guarded: events for a cancelled seller order are ignored.
 */
@injectable()
export class ShipmentUpdateService {
  constructor(
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.InventoryService) private readonly inventory: IInventoryService,
    @inject(TOKENS.OrderItemRepository) private readonly items: OrderItemRepository,
    @inject(TOKENS.OrderLifecycleService) private readonly lifecycle: OrderLifecycleService,
  ) {}

  async handle(envelope: EventEnvelope, trx: DbTransaction): Promise<void> {
    const rule = RULES[envelope.eventType];
    if (!rule)
      throw new PermanentEventError(`ordering.shipment-updates does not handle ${envelope.eventType}`);
    const orderId = uuidField(envelope, 'orderId');
    const sellerOrderId = uuidField(envelope, 'sellerOrderId');
    const change = this.changeFor(envelope);

    const locked = await this.lifecycle.lock(orderId, trx);
    const current = locked?.sellerOrders.find((s) => s.id === sellerOrderId);
    if (!locked || !current) {
      throw new PermanentEventError(
        `${envelope.eventType}: seller order ${sellerOrderId} of order ${orderId} not found`,
      );
    }
    if (!rule.from.includes(current.status)) {
      this.skipOrRetry(envelope, current, rule.early);
      return;
    }

    const moved = await this.lifecycle.transition(locked, current.id, rule.from, change, AGENT, null, trx);
    if (!moved) throw new Error(`seller order ${current.id} changed under the order lock`);
    if (envelope.eventType === ShipmentDelivered.type) await this.delivered(envelope, locked, moved, trx);
    await this.lifecycle.settle(locked, AGENT, trx);
  }

  /** The transition each event applies (spec 09 §1.1). */
  private changeFor(envelope: EventEnvelope): SellerOrderTransition {
    switch (envelope.eventType) {
      case ShipmentPickedUp.type:
        return { status: S.PICKED_UP, pickedUpAt: dateField(envelope, 'pickedUpAt') };
      case ShipmentOutForDelivery.type:
        return { status: S.OUT_FOR_DELIVERY };
      case ShipmentAttemptFailed.type:
        return {
          status: envelope.payload.returningToSeller === true ? S.RETURNING_TO_SELLER : S.DELIVERY_FAILED,
        };
      default:
        return { status: S.DELIVERED, deliveredAt: dateField(envelope, 'deliveredAt') };
    }
  }

  /**
   * UC-OR-8 steps 2–4: commit the stock, the agent fee share (overview §5, Q-27, S-13) and the
   * `seller_order.delivered` event that finance and payments book from.
   */
  private async delivered(
    envelope: EventEnvelope,
    locked: LockedOrder,
    sellerOrder: SellerOrder,
    trx: DbTransaction,
  ): Promise<void> {
    const { order } = locked;
    const items = await this.items.findBySellerOrderIds([sellerOrder.id], trx);
    await this.inventory.commit(
      items.map((item) => item.id),
      trx,
    );

    const cod = order.paymentMethod === PaymentMethod.COD;
    const codCollected = envelope.payload.codCollectedAmount;
    if (cod && typeof codCollected !== 'string') {
      throw new PermanentEventError(`${envelope.eventType}: codCollectedAmount is required for a COD order`);
    }
    await this.outbox.add(trx, {
      contract: SellerOrderDelivered,
      aggregateId: sellerOrder.id,
      payload: {
        sellerOrderId: sellerOrder.id,
        orderId: order.id,
        sellerId: sellerOrder.sellerId,
        paymentMethod: order.paymentMethod,
        subtotal: sellerOrder.subtotal.toString(),
        commissionRate: sellerOrder.commissionRate.toString(),
        commission: sellerOrder.commission.toString(),
        sellerNet: sellerOrder.sellerNet.toString(),
        agentId: uuidField(envelope, 'agentId'),
        agentFeeShare: agentFeeShare(locked, sellerOrder.id).toString(),
        codCollectedAmount: cod ? moneyField(envelope, 'codCollectedAmount').toString() : null,
        deliveryFeeCollected: envelope.payload.deliveryFeeCollected === true,
        deliveryFeeAmount: moneyField(envelope, 'deliveryFeeAmount').toString(),
        deliveredAt: dateField(envelope, 'deliveredAt').toISOString(),
      },
    });
  }

  /** A stale event (already past, or the seller order was cancelled) is a no-op; an early one is retried (OR-14). */
  private skipOrRetry(
    envelope: EventEnvelope,
    current: SellerOrder,
    early: readonly SellerOrderStatus[],
  ): void {
    const fields = { eventType: envelope.eventType, sellerOrderId: current.id, status: current.status };
    if (early.includes(current.status)) {
      throw new ShipmentEventTooEarlyError(
        `${envelope.eventType} arrived before an earlier shipment event (seller order is ${current.status})`,
      );
    }
    this.logger.warn('shipment event ignored for the seller order state', {
      event: 'SHIPMENT_EVENT_IGNORED',
      ...fields,
    });
  }
}

/**
 * Spec 09 §3.8: `round(fee × rate)` split equally over every seller order of the checkout (cancelled
 * ones included), rounded down to the piastre; the leftover piastres go to the delivery that closes
 * the order, and stay with the platform otherwise (S-13). `locked` already holds this delivery.
 */
export function agentFeeShare(locked: LockedOrder, sellerOrderId: string): Money {
  const { order, sellerOrders } = locked;
  const total = order.deliveryFee.timesRate(order.agentFeeShareRate);
  const { base, remainder } = total.splitEvenly(sellerOrders.length);
  const closesOrder = sellerOrders.every((s) => s.id === sellerOrderId || isTerminal(s.status));
  return closesOrder ? base.plus(remainder) : base;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A payload that can never be processed goes straight to the DLQ (retries can't fix it). */
function uuidField(envelope: EventEnvelope, field: string): string {
  const value = envelope.payload[field];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new PermanentEventError(`${envelope.eventType}: payload.${field} must be a UUID`);
  }
  return value;
}

function dateField(envelope: EventEnvelope, field: string): Date {
  const value = envelope.payload[field];
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new PermanentEventError(`${envelope.eventType}: payload.${field} must be an ISO-8601 date`);
  }
  return date;
}

function moneyField(envelope: EventEnvelope, field: string): Money {
  const value = envelope.payload[field];
  try {
    if (typeof value !== 'string') throw new RangeError('not a string');
    const money = Money.of(value);
    if (money.isNegative()) throw new RangeError('negative');
    return money;
  } catch {
    throw new PermanentEventError(
      `${envelope.eventType}: payload.${field} must be a non-negative money string`,
    );
  }
}
