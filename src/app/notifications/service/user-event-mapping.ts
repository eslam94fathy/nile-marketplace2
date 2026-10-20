import {
  type EventEnvelope,
  PaymentExpired,
  PaymentFailed,
  OrderPlaced,
  PermanentEventError,
  SellerOrderAccepted,
  SellerOrderCancelled,
  SellerOrderDelivered,
  ShipmentAssigned,
  ShipmentAttemptFailed,
  ShipmentOutForDelivery,
  UserSessionsRevoked,
  UserSuspended,
} from '../../../lib/events';
import { type NotificationParty, SellerOrderCancelReason, SellerOrderStatus } from '../../ordering';
import { NotificationLink } from '../constants';
import { NotificationCategory, NotificationType } from '../enums';

/** The events of spec 13 §8.2 that exist by R2-P2 (support, reviews, returns come in their phases). */
export const USER_EVENTS = [
  OrderPlaced,
  SellerOrderAccepted,
  SellerOrderCancelled,
  SellerOrderDelivered,
  PaymentFailed,
  PaymentExpired,
  ShipmentAssigned,
  ShipmentOutForDelivery,
  ShipmentAttemptFailed,
  // Not notifications: they drop the user's push subscriptions (UC-NO-4, NO-8).
  UserSuspended,
  UserSessionsRevoked,
] as const;

/** Events that end a user's sessions: their browsers must stop showing lock-screen texts (NO-8). */
export const SESSION_END_EVENTS: ReadonlySet<string> = new Set([
  UserSuspended.type,
  UserSessionsRevoked.type,
]);

/** Events whose mapping needs the order's parties (order number, customer, seller orders). */
export const NEEDS_PARTY: ReadonlySet<string> = new Set(
  USER_EVENTS.filter(
    (contract) => contract !== ShipmentAssigned && !SESSION_END_EVENTS.has(contract.type),
  ).map((contract) => contract.type),
);

export type RecipientKind = 'customer' | 'seller' | 'agent';

/** One notification for one profile, before its user id is resolved. */
export interface NotificationDraft {
  recipient: { kind: RecipientKind; id: string };
  category: NotificationCategory;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function idOf(envelope: EventEnvelope, key: string): string {
  const value = envelope.payload[key];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new PermanentEventError(`${envelope.eventType} payload has no valid ${key}`);
  }
  return value;
}

/** Cancellations of an order that was never paid: the customer already gets `payment_failed`. */
const UNPAID_CANCEL_REASONS: ReadonlySet<string> = new Set([
  SellerOrderCancelReason.PAYMENT_FAILED,
  SellerOrderCancelReason.PAYMENT_EXPIRED,
]);

/**
 * Spec 13 §8.2: English texts with the order number only, no names, addresses or amounts (R-7).
 * `party` is the order re-read from ordering; it is required for every event in NEEDS_PARTY.
 */
export function mapUserEvent(
  envelope: EventEnvelope,
  party: NotificationParty | undefined,
): NotificationDraft[] {
  const customer = (draft: Omit<NotificationDraft, 'recipient' | 'link'>): NotificationDraft => {
    if (!party) throw new Error(`${envelope.eventType} needs the order's parties`);
    return {
      ...draft,
      recipient: { kind: 'customer', id: party.customerId },
      link: NotificationLink.customerOrder(party.orderId),
    };
  };
  const n = party?.orderNumber ?? '';
  // "Part of order" only when the order has several seller orders (spec 13 §8.2, NO-13).
  const subject = party && party.sellerOrders.length > 1 ? `Part of order #${n}` : `Order #${n}`;

  switch (envelope.eventType) {
    case OrderPlaced.type: {
      if (!party) return [];
      const sellers = party.sellerOrders
        .filter((s) => s.status !== SellerOrderStatus.PENDING_PAYMENT)
        .map((s): NotificationDraft => ({
          recipient: { kind: 'seller', id: s.sellerId },
          category: NotificationCategory.ORDERS,
          type: NotificationType.SELLER_ORDER_RECEIVED,
          title: 'New order',
          body: `Order #${n} is waiting for you to accept it.`,
          link: NotificationLink.sellerOrder(s.sellerOrderId),
        }));
      return [
        customer({
          category: NotificationCategory.ORDERS,
          type: NotificationType.ORDER_PLACED,
          title: 'Order placed',
          body: `Order #${n} is confirmed.`,
        }),
        ...sellers,
      ];
    }
    case SellerOrderAccepted.type:
      return [
        customer({
          category: NotificationCategory.ORDERS,
          type: NotificationType.SELLER_ORDER_ACCEPTED,
          title: 'Order accepted',
          body: `${subject} was accepted.`,
        }),
      ];
    case SellerOrderCancelled.type:
      return sellerOrderCancelled(envelope, customer, subject, n);
    case PaymentFailed.type:
    case PaymentExpired.type:
      return [
        customer({
          category: NotificationCategory.ORDERS,
          type: NotificationType.PAYMENT_FAILED,
          title: 'Payment not completed',
          body: `Order #${n} was not paid.`,
        }),
      ];
    case ShipmentAssigned.type: {
      const shipmentId = idOf(envelope, 'shipmentId');
      return [
        {
          recipient: { kind: 'agent', id: idOf(envelope, 'agentId') },
          category: NotificationCategory.SHIPMENTS,
          type: NotificationType.SHIPMENT_ASSIGNED,
          title: 'New pickup',
          body: 'A new shipment is assigned to you.',
          link: NotificationLink.agentShipment(shipmentId),
        },
      ];
    }
    case ShipmentOutForDelivery.type:
      return [
        customer({
          category: NotificationCategory.SHIPMENTS,
          type: NotificationType.OUT_FOR_DELIVERY,
          title: 'On the way',
          body: `Order #${n} is out for delivery.`,
        }),
      ];
    case ShipmentAttemptFailed.type:
      return [
        customer({
          category: NotificationCategory.SHIPMENTS,
          type: NotificationType.DELIVERY_ATTEMPT_FAILED,
          title: 'Delivery attempt failed',
          body: `We couldn't deliver order #${n}.`,
        }),
      ];
    case SellerOrderDelivered.type:
      return [
        customer({
          category: NotificationCategory.SHIPMENTS,
          type: NotificationType.DELIVERED,
          title: 'Delivered',
          body: `Order #${n} was delivered.`,
        }),
      ];
    default:
      throw new PermanentEventError(`notifications.user-events has no mapping for ${envelope.eventType}`);
  }
}

/**
 * The customer for any reason except an unpaid order's (they get `payment_failed` instead); the seller
 * unless the seller cancelled it, and never for an order they never saw (`pending_payment`) (NO-14).
 */
function sellerOrderCancelled(
  envelope: EventEnvelope,
  customer: (draft: Omit<NotificationDraft, 'recipient' | 'link'>) => NotificationDraft,
  subject: string,
  orderNumber: string,
): NotificationDraft[] {
  const reason = envelope.payload.reason;
  const previousStatus = envelope.payload.previousStatus;
  const text = { category: NotificationCategory.ORDERS, type: NotificationType.SELLER_ORDER_CANCELLED };
  const drafts: NotificationDraft[] = [];
  if (typeof reason !== 'string' || !UNPAID_CANCEL_REASONS.has(reason)) {
    drafts.push(customer({ ...text, title: 'Order cancelled', body: `${subject} was cancelled.` }));
  }
  if (
    reason !== SellerOrderCancelReason.SELLER_CANCELLED &&
    previousStatus !== SellerOrderStatus.PENDING_PAYMENT
  ) {
    const sellerOrderId = idOf(envelope, 'sellerOrderId');
    drafts.push({
      ...text,
      recipient: { kind: 'seller', id: idOf(envelope, 'sellerId') },
      title: 'Order cancelled',
      // The seller's view is its own seller order: the whole order number, never "part of".
      body: `Order #${orderNumber} was cancelled.`,
      link: NotificationLink.sellerOrder(sellerOrderId),
    });
  }
  return drafts;
}
