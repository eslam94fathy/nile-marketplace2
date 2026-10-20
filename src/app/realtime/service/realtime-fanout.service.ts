import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import {
  type EventEnvelope,
  MediaFailed,
  MediaReady,
  OrderClosed,
  OrderPlaced,
  PaymentExpired,
  PaymentFailed,
  PaymentPaid,
  PermanentEventError,
  SellerOrderAccepted,
  SellerOrderCancelled,
  SellerOrderDelivered,
  SellerOrderItemsCancelled,
  SellerOrderReadyForPickup,
  SellerOrderReturned,
  ShipmentAssigned,
  ShipmentAttemptFailed,
  ShipmentDelivered,
  ShipmentOutForDelivery,
  ShipmentPickedUp,
  UserSuspended,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import {
  DisconnectReason,
  type IRealtimeEmitter,
  type RealtimeMessage,
  type RealtimeMessageData,
  RealtimeMessageType as T,
  RealtimeRoom,
} from '../../../lib/realtime';
import { type IOrderingDirectory, type NotificationParty, SellerOrderStatus } from '../../ordering';
import { MediaStatusValue, PaymentStatusValue, ShipmentStatusValue } from '../constants';

/** Every event the fan-out consumes (spec 15 §5, the ones that exist by R2-P2). */
export const FANOUT_EVENTS = [
  OrderPlaced,
  OrderClosed,
  SellerOrderAccepted,
  SellerOrderReadyForPickup,
  SellerOrderItemsCancelled,
  SellerOrderCancelled,
  SellerOrderReturned,
  SellerOrderDelivered,
  PaymentPaid,
  PaymentFailed,
  PaymentExpired,
  ShipmentAssigned,
  ShipmentPickedUp,
  ShipmentOutForDelivery,
  ShipmentAttemptFailed,
  ShipmentDelivered,
  MediaReady,
  MediaFailed,
  UserSuspended,
] as const;

const SELLER_ORDER_EVENTS: ReadonlySet<string> = new Set(
  [
    SellerOrderAccepted,
    SellerOrderReadyForPickup,
    SellerOrderItemsCancelled,
    SellerOrderCancelled,
    SellerOrderReturned,
    SellerOrderDelivered,
  ].map((contract) => contract.type),
);

/**
 * Payment and shipment statuses come from the event type (RT-9): realtime may read only ordering's
 * state (architecture §14.2), and the client refetches on every message anyway.
 */
const PAYMENT_STATUS_BY_EVENT: ReadonlyMap<string, string> = new Map<string, string>([
  [PaymentPaid.type, PaymentStatusValue.PAID],
  [PaymentFailed.type, PaymentStatusValue.FAILED],
  [PaymentExpired.type, PaymentStatusValue.EXPIRED],
]);
const SHIPMENT_STATUS_BY_EVENT: ReadonlyMap<string, (envelope: EventEnvelope) => string> = new Map<
  string,
  (envelope: EventEnvelope) => string
>([
  [ShipmentPickedUp.type, () => ShipmentStatusValue.PICKED_UP],
  [ShipmentOutForDelivery.type, () => ShipmentStatusValue.OUT_FOR_DELIVERY],
  [ShipmentDelivered.type, () => ShipmentStatusValue.DELIVERED],
  [
    ShipmentAttemptFailed.type,
    (envelope: EventEnvelope) =>
      envelope.payload.returningToSeller === true
        ? ShipmentStatusValue.RETURNING_TO_SELLER
        : ShipmentStatusValue.DELIVERY_FAILED,
  ],
]);
const MEDIA_STATUS_BY_EVENT: ReadonlyMap<string, string> = new Map<string, string>([
  [MediaReady.type, MediaStatusValue.READY],
  [MediaFailed.type, MediaStatusValue.FAILED],
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed payload can never succeed: dead-letter it. */
function idOf(envelope: EventEnvelope, key: string): string {
  const value = envelope.payload[key];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new PermanentEventError(`${envelope.eventType} payload has no valid ${key}`);
  }
  return value;
}

function optionalIdOf(envelope: EventEnvelope, key: string): string | null {
  return envelope.payload[key] === null ? null : idOf(envelope, key);
}

/**
 * Consumer `realtime.fanout` (spec 15 UC-RT-2): maps domain events to socket messages. Parties and
 * order / seller-order statuses are re-read from ordering in one batched call, so a late event still
 * shows the current status. No transaction, no dedupe row: a repeat sends the same message again,
 * which clients drop by `eventId` + `type`. A read failure throws (retry); Redis being down is a warn
 * inside the emitter (RT-3).
 */
@injectable()
export class RealtimeFanoutService {
  constructor(
    @inject(TOKENS.OrderingDirectory) private readonly ordering: IOrderingDirectory,
    @inject(TOKENS.RealtimeEmitter) private readonly emitter: IRealtimeEmitter,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const type = envelope.eventType;
    if (type === OrderPlaced.type) return this.orderPlaced(envelope);
    if (type === OrderClosed.type) return this.orderUpdated(envelope);
    const paymentStatus = PAYMENT_STATUS_BY_EVENT.get(type);
    if (paymentStatus !== undefined) return this.paymentUpdated(envelope, paymentStatus);
    if (SELLER_ORDER_EVENTS.has(type)) return this.sellerOrderUpdated(envelope);
    if (type === ShipmentAssigned.type) return this.shipmentAssigned(envelope);
    const shipmentStatus = SHIPMENT_STATUS_BY_EVENT.get(type);
    if (shipmentStatus !== undefined) return this.shipmentUpdated(envelope, shipmentStatus(envelope));
    const mediaStatus = MEDIA_STATUS_BY_EVENT.get(type);
    if (mediaStatus !== undefined) return this.mediaUpdated(envelope, mediaStatus);
    if (type === UserSuspended.type) {
      this.emitter.disconnectUser(idOf(envelope, 'userId'), DisconnectReason.ACCOUNT_SUSPENDED);
      return;
    }
    throw new PermanentEventError(`realtime.fanout has no mapping for ${type}`);
  }

  /** `order.updated` to the customer, and `seller_order.placed` to each seller whose order is live. */
  private async orderPlaced(envelope: EventEnvelope): Promise<void> {
    const party = await this.partyOfOrder(envelope, idOf(envelope, 'orderId'));
    if (!party) return;
    this.sendOrderUpdated(envelope, party);
    for (const sellerOrder of party.sellerOrders) {
      if (sellerOrder.status === SellerOrderStatus.PENDING_PAYMENT) continue;
      this.send(envelope, T.SELLER_ORDER_PLACED, [RealtimeRoom.seller(sellerOrder.sellerId)], {
        sellerOrderId: sellerOrder.sellerOrderId,
        orderNumber: party.orderNumber,
      });
    }
  }

  private async orderUpdated(envelope: EventEnvelope): Promise<void> {
    const party = await this.partyOfOrder(envelope, idOf(envelope, 'orderId'));
    if (party) this.sendOrderUpdated(envelope, party);
  }

  /** `order.updated` (re-read) and `payment.updated` (RT-4: the Kashier return page waits for it). */
  private async paymentUpdated(envelope: EventEnvelope, paymentStatus: string): Promise<void> {
    const orderId = idOf(envelope, 'orderId');
    const party = await this.partyOfOrder(envelope, orderId);
    if (!party) return;
    this.sendOrderUpdated(envelope, party);
    this.send(envelope, T.PAYMENT_UPDATED, [RealtimeRoom.customer(party.customerId)], {
      orderId,
      paymentStatus,
    });
  }

  private async sellerOrderUpdated(envelope: EventEnvelope): Promise<void> {
    const sellerOrderId = idOf(envelope, 'sellerOrderId');
    const party = await this.partyOfSellerOrder(envelope, sellerOrderId);
    const sellerOrder = party?.sellerOrders.find((s) => s.sellerOrderId === sellerOrderId);
    if (!party || !sellerOrder) return;
    this.send(
      envelope,
      T.SELLER_ORDER_UPDATED,
      [RealtimeRoom.customer(party.customerId), RealtimeRoom.seller(sellerOrder.sellerId)],
      { sellerOrderId, orderId: party.orderId, status: sellerOrder.status },
    );
  }

  /** The new agent gets `shipment.assigned`; a replaced agent `shipment.unassigned`. */
  private shipmentAssigned(envelope: EventEnvelope): void {
    const data = { shipmentId: idOf(envelope, 'shipmentId'), sellerOrderId: idOf(envelope, 'sellerOrderId') };
    const agentId = idOf(envelope, 'agentId');
    const previousAgentId = optionalIdOf(envelope, 'previousAgentId');
    this.send(envelope, T.SHIPMENT_ASSIGNED, [RealtimeRoom.agent(agentId)], data);
    if (previousAgentId !== null && previousAgentId !== agentId) {
      this.send(envelope, T.SHIPMENT_UNASSIGNED, [RealtimeRoom.agent(previousAgentId)], data);
    }
  }

  private async shipmentUpdated(envelope: EventEnvelope, status: string): Promise<void> {
    const sellerOrderId = idOf(envelope, 'sellerOrderId');
    const party = await this.partyOfSellerOrder(envelope, sellerOrderId);
    if (!party) return;
    this.send(
      envelope,
      T.SHIPMENT_UPDATED,
      [RealtimeRoom.customer(party.customerId), RealtimeRoom.agent(idOf(envelope, 'agentId'))],
      {
        shipmentId: idOf(envelope, 'shipmentId'),
        sellerOrderId,
        orderId: party.orderId,
        status,
      },
    );
  }

  private mediaUpdated(envelope: EventEnvelope, status: string): void {
    this.send(envelope, T.MEDIA_UPDATED, [RealtimeRoom.user(idOf(envelope, 'ownerUserId'))], {
      mediaId: idOf(envelope, 'mediaId'),
      status,
    });
  }

  private sendOrderUpdated(envelope: EventEnvelope, party: NotificationParty): void {
    this.send(envelope, T.ORDER_UPDATED, [RealtimeRoom.customer(party.customerId)], {
      orderId: party.orderId,
      orderNumber: party.orderNumber,
      status: party.status,
    });
  }

  private send<K extends keyof RealtimeMessageData>(
    envelope: EventEnvelope,
    type: K,
    rooms: readonly string[],
    data: RealtimeMessageData[K],
  ): void {
    const message: RealtimeMessage<K> = {
      type,
      eventId: envelope.eventId,
      occurredAt: envelope.occurredAt,
      data,
    };
    this.emitter.toRooms(rooms, message);
  }

  private async partyOfOrder(
    envelope: EventEnvelope,
    orderId: string,
  ): Promise<NotificationParty | undefined> {
    const [party] = await this.ordering.getNotificationParties({ orderIds: [orderId] });
    if (!party) this.warnMissing(envelope);
    return party;
  }

  private async partyOfSellerOrder(
    envelope: EventEnvelope,
    sellerOrderId: string,
  ): Promise<NotificationParty | undefined> {
    const [party] = await this.ordering.getNotificationParties({ sellerOrderIds: [sellerOrderId] });
    if (!party) this.warnMissing(envelope);
    return party;
  }

  /** Orders are never deleted, so this means a payload naming a row that doesn't exist: nothing to send. */
  private warnMissing(envelope: EventEnvelope): void {
    this.logger.warn('realtime fan-out: order not found, nothing sent', {
      eventId: envelope.eventId,
      eventType: envelope.eventType,
    });
  }
}
