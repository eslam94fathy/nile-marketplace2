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
  PaymentRefunded,
  PaymentRefundRecorded,
  PermanentEventError,
  ReturnShipmentDelivered,
  ReturnShipmentFailed,
  ReturnShipmentPickedUp,
  type ReturnStatusValue,
  ReturnStatusChanged,
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
  SupportMessageCreated,
  SupportTicketAssigned,
  SupportTicketOpened,
  SupportTicketStatusChanged,
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
import { type ISupportDirectory, MessageKind } from '../../support';
import {
  MediaStatusValue,
  PaymentStatusValue,
  RefundPaymentStatusValue,
  ShipmentKindValue,
  ShipmentStatusValue,
} from '../constants';

/** Every event the fan-out consumes (spec 15 §5, §8; the ones that exist by R2-P6). */
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
  SupportTicketOpened,
  SupportMessageCreated,
  SupportTicketAssigned,
  SupportTicketStatusChanged,
  ReturnStatusChanged,
  ReturnShipmentPickedUp,
  ReturnShipmentDelivered,
  ReturnShipmentFailed,
  PaymentRefunded,
  PaymentRefundRecorded,
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
/** Return shipments: the ids come with the event (spec 11 DE-27), the agent alone follows them (RT-22). */
const RETURN_SHIPMENT_STATUS_BY_EVENT: ReadonlyMap<string, string> = new Map<string, string>([
  [ReturnShipmentPickedUp.type, ShipmentStatusValue.PICKED_UP],
  [ReturnShipmentDelivered.type, ShipmentStatusValue.DELIVERED],
  [ReturnShipmentFailed.type, ShipmentStatusValue.CANCELLED],
]);
const REFUND_EVENTS: ReadonlySet<string> = new Set([PaymentRefunded.type, PaymentRefundRecorded.type]);
const REFUND_PAYMENT_STATUSES: ReadonlySet<unknown> = new Set(Object.values(RefundPaymentStatusValue));
/** Returns waiting for an admin also go to the `admins` room (spec 15 §8). */
const ADMIN_RETURN_STATUSES: ReadonlySet<unknown> = new Set<ReturnStatusValue>(['escalated', 'disputed']);
const RETURN_STATUSES: ReadonlySet<unknown> = new Set<ReturnStatusValue>([
  'requested',
  'rejected',
  'escalated',
  'approved',
  'picked_up',
  'received',
  'disputed',
  'completed',
  'refused',
  'cancelled',
  'pickup_failed',
]);

const MEDIA_STATUS_BY_EVENT: ReadonlyMap<string, string> = new Map<string, string>([
  [MediaReady.type, MediaStatusValue.READY],
  [MediaFailed.type, MediaStatusValue.FAILED],
]);

/** Every ticket change is announced the same way, from a re-read (SU-19). */
const SUPPORT_TICKET_EVENTS: ReadonlySet<string> = new Set(
  [SupportTicketOpened, SupportTicketAssigned, SupportTicketStatusChanged].map((contract) => contract.type),
);
/** The server's lines go to the opener's side like an admin's (spec 15 §3.1). */
const SUPPORT_SIDE_SENDERS: ReadonlySet<unknown> = new Set(['admin', 'system']);

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
    @inject(TOKENS.SupportDirectory) private readonly support: ISupportDirectory,
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
    const returnShipmentStatus = RETURN_SHIPMENT_STATUS_BY_EVENT.get(type);
    if (returnShipmentStatus !== undefined) return this.returnShipmentUpdated(envelope, returnShipmentStatus);
    if (type === ReturnStatusChanged.type) return this.returnUpdated(envelope);
    if (REFUND_EVENTS.has(type)) return this.refunded(envelope);
    const mediaStatus = MEDIA_STATUS_BY_EVENT.get(type);
    if (mediaStatus !== undefined) return this.mediaUpdated(envelope, mediaStatus);
    if (type === SupportMessageCreated.type) return this.supportMessageCreated(envelope);
    if (SUPPORT_TICKET_EVENTS.has(type)) return this.ticketUpdated(envelope);
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
        kind: ShipmentKindValue.DELIVERY,
      },
    );
  }

  private returnShipmentUpdated(envelope: EventEnvelope, status: string): void {
    this.send(envelope, T.SHIPMENT_UPDATED, [RealtimeRoom.agent(idOf(envelope, 'agentId'))], {
      shipmentId: idOf(envelope, 'shipmentId'),
      sellerOrderId: idOf(envelope, 'sellerOrderId'),
      orderId: idOf(envelope, 'orderId'),
      status,
      kind: ShipmentKindValue.RETURN,
    });
  }

  /** No re-read: the payload names both sides, and the client refetches the return (spec 15 §8). */
  private returnUpdated(envelope: EventEnvelope): void {
    const status = envelope.payload.to;
    if (typeof status !== 'string' || !RETURN_STATUSES.has(status)) {
      throw new PermanentEventError(`${envelope.eventType} payload has no valid to`);
    }
    const rooms = [
      RealtimeRoom.customer(idOf(envelope, 'customerId')),
      RealtimeRoom.seller(idOf(envelope, 'sellerId')),
    ];
    if (ADMIN_RETURN_STATUSES.has(status)) rooms.push(RealtimeRoom.ADMINS);
    this.send(envelope, T.RETURN_UPDATED, rooms, {
      returnId: idOf(envelope, 'returnId'),
      sellerOrderId: idOf(envelope, 'sellerOrderId'),
      orderId: idOf(envelope, 'orderId'),
      status,
    });
  }

  /** RT-23: only a refund that moved the payment's status; a recorded COD refund (`null`) sends nothing. */
  private refunded(envelope: EventEnvelope): void {
    const status = envelope.payload.newPaymentStatus;
    if (status === null) return;
    if (typeof status !== 'string' || !REFUND_PAYMENT_STATUSES.has(status)) {
      throw new PermanentEventError(`${envelope.eventType} payload has no valid newPaymentStatus`);
    }
    this.send(envelope, T.PAYMENT_UPDATED, [RealtimeRoom.customer(idOf(envelope, 'customerId'))], {
      orderId: idOf(envelope, 'orderId'),
      paymentStatus: status,
    });
  }

  private mediaUpdated(envelope: EventEnvelope, status: string): void {
    this.send(envelope, T.MEDIA_UPDATED, [RealtimeRoom.user(idOf(envelope, 'ownerUserId'))], {
      mediaId: idOf(envelope, 'mediaId'),
      status,
    });
  }

  /**
   * The ticket room, plus the other side: the opener for an admin's or the server's line, the admins for
   * the opener's. Internal notes go to admins only, never to the ticket room the opener may be in.
   */
  private supportMessageCreated(envelope: EventEnvelope): void {
    const ticketId = idOf(envelope, 'ticketId');
    const data = { ticketId, messageId: idOf(envelope, 'messageId') };
    let rooms: string[];
    if (envelope.payload.kind === MessageKind.INTERNAL_NOTE) rooms = [RealtimeRoom.ADMINS];
    else if (SUPPORT_SIDE_SENDERS.has(envelope.payload.senderRole)) {
      rooms = [RealtimeRoom.ticket(ticketId), RealtimeRoom.user(idOf(envelope, 'openerUserId'))];
    } else rooms = [RealtimeRoom.ticket(ticketId), RealtimeRoom.ADMINS];
    this.send(envelope, T.SUPPORT_MESSAGE_CREATED, rooms, data);
  }

  /** `support.ticket_updated` with the current status and assignee, to everyone who follows the ticket. */
  private async ticketUpdated(envelope: EventEnvelope): Promise<void> {
    const ticketId = idOf(envelope, 'ticketId');
    const state = (await this.support.getTicketStates([ticketId])).get(ticketId);
    if (!state) {
      // Tickets are never deleted: a payload naming a missing one has nothing to show.
      this.logger.warn('realtime fan-out: ticket not found, nothing sent', {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
      });
      return;
    }
    this.send(
      envelope,
      T.SUPPORT_TICKET_UPDATED,
      [RealtimeRoom.ticket(ticketId), RealtimeRoom.user(state.openerUserId), RealtimeRoom.ADMINS],
      { ticketId, status: state.status, assignedAdminId: state.assignedAdminUserId },
    );
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
