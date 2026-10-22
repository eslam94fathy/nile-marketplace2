import {
  type EventEnvelope,
  PaymentExpired,
  PaymentFailed,
  PaymentRefunded,
  PaymentRefundRecorded,
  OrderPlaced,
  PermanentEventError,
  ProductBlocked,
  ReturnStatusChanged,
  ReviewCreated,
  ReviewReplied,
  SellerOrderAccepted,
  SellerOrderCancelled,
  SellerOrderDelivered,
  ShipmentAssigned,
  ShipmentAttemptFailed,
  ShipmentOutForDelivery,
  SupportMessageCreated,
  SupportTicketStatusChanged,
  UserSessionsRevoked,
  UserSuspended,
} from '../../../lib/events';
import { type NotificationParty, SellerOrderCancelReason, SellerOrderStatus } from '../../ordering';
import { NotificationLink } from '../constants';
import { NotificationCategory, NotificationType } from '../enums';

/** The events of spec 13 §8.2, §8.8 and §8.9 (coupons add none). */
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
  SupportMessageCreated,
  SupportTicketStatusChanged,
  ReviewCreated,
  ReviewReplied,
  ProductBlocked,
  ReturnStatusChanged,
  PaymentRefunded,
  PaymentRefundRecorded,
  // Not notifications: they drop the user's push subscriptions (UC-NO-4, NO-8).
  UserSuspended,
  UserSessionsRevoked,
] as const;

/** Events that end a user's sessions: their browsers must stop showing lock-screen texts (NO-8). */
export const SESSION_END_EVENTS: ReadonlySet<string> = new Set([
  UserSuspended.type,
  UserSessionsRevoked.type,
]);

/**
 * Events that name their recipient themselves, with nothing of the order to show: support (user ids, the
 * ticket number, NO-31), reviews (the seller or customer profile, NO-32), the product block (NO-33) and
 * returns (both profiles and both numbers, NO-34).
 */
const NO_PARTY_EVENTS: ReadonlySet<string> = new Set([
  SupportMessageCreated.type,
  SupportTicketStatusChanged.type,
  ReviewCreated.type,
  ReviewReplied.type,
  ProductBlocked.type,
  ReturnStatusChanged.type,
]);

/** Events whose mapping needs the order's parties (order number, customer, seller orders). */
export const NEEDS_PARTY: ReadonlySet<string> = new Set(
  USER_EVENTS.filter(
    (contract) =>
      contract !== ShipmentAssigned &&
      !SESSION_END_EVENTS.has(contract.type) &&
      !NO_PARTY_EVENTS.has(contract.type),
  ).map((contract) => contract.type),
);

/** `user`: the id is already a user id (support). */
export type RecipientKind = 'customer' | 'seller' | 'agent' | 'user';

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
    case SupportMessageCreated.type:
      return supportMessageCreated(envelope);
    case SupportTicketStatusChanged.type:
      return envelope.payload.to === TICKET_RESOLVED
        ? [
            {
              recipient: { kind: 'user', id: idOf(envelope, 'openerUserId') },
              category: NotificationCategory.SUPPORT,
              type: NotificationType.SUPPORT_RESOLVED,
              title: 'Ticket resolved',
              body: `${ticketNumberOf(envelope)} was marked resolved.`,
              link: NotificationLink.supportTicket(idOf(envelope, 'ticketId')),
            },
          ]
        : [];
    // Spec 13 §8.8 (RV-8): no product names in the text (R-7 style).
    case ReviewCreated.type:
      return [
        {
          recipient: { kind: 'seller', id: idOf(envelope, 'sellerId') },
          category: NotificationCategory.ORDERS,
          type: NotificationType.REVIEW_RECEIVED,
          title: 'New review',
          body: 'One of your products has a new review.',
          link: NotificationLink.sellerReviews(),
        },
      ];
    case ReviewReplied.type:
      return [
        {
          recipient: { kind: 'customer', id: idOf(envelope, 'customerId') },
          category: NotificationCategory.ORDERS,
          type: NotificationType.REVIEW_REPLIED,
          title: 'Seller replied',
          body: 'The seller replied to your review.',
          link: NotificationLink.myReview(idOf(envelope, 'reviewId')),
        },
      ];
    // Spec 13 §8.8 (BO-8): the reason is only in the seller's product view.
    case ProductBlocked.type:
      return [
        {
          recipient: { kind: 'seller', id: idOf(envelope, 'sellerId') },
          category: NotificationCategory.ORDERS,
          type: NotificationType.PRODUCT_BLOCKED,
          title: 'Product blocked',
          body: 'A product was blocked by the platform.',
          link: NotificationLink.sellerProduct(idOf(envelope, 'productId')),
        },
      ];
    case ReturnStatusChanged.type:
      return returnStatusChanged(envelope);
    // NO-34: every refund reason, R1 manual refunds included (spec 10 PA-26).
    case PaymentRefunded.type:
    case PaymentRefundRecorded.type:
      return [
        customer({
          category: NotificationCategory.ORDERS,
          type: NotificationType.REFUND_ISSUED,
          title: 'Refund issued',
          body: `Your refund for order #${n} was issued.`,
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

/** Support statuses and roles as sent in the payloads (spec 02 §6.2); support's enums mirror them. */
const TICKET_RESOLVED = 'resolved';
const PUBLIC_MESSAGE = 'message';
const USER_SENDERS: ReadonlySet<unknown> = new Set(['customer', 'seller']);
const TICKET_NUMBER_PATTERN = /^T-\d{9}$/;

function ticketNumberOf(envelope: EventEnvelope): string {
  const value = envelope.payload.ticketNumber;
  if (typeof value !== 'string' || !TICKET_NUMBER_PATTERN.test(value)) {
    throw new PermanentEventError(`${envelope.eventType} payload has no valid ticketNumber`);
  }
  return value;
}

/**
 * A public admin message → the opener; a user message on an assigned ticket → the assignee (spec 13
 * §8.2). Notes and system lines notify nobody; new tickets reach admins by socket only (NO-9).
 */
function supportMessageCreated(envelope: EventEnvelope): NotificationDraft[] {
  if (envelope.payload.kind !== PUBLIC_MESSAGE) return [];
  const ticketId = idOf(envelope, 'ticketId');
  const ticketNumber = ticketNumberOf(envelope);
  if (envelope.payload.senderRole === 'admin') {
    return [
      {
        recipient: { kind: 'user', id: idOf(envelope, 'openerUserId') },
        category: NotificationCategory.SUPPORT,
        type: NotificationType.SUPPORT_REPLY,
        title: 'New reply',
        body: `Support replied on ${ticketNumber}.`,
        link: NotificationLink.supportTicket(ticketId),
      },
    ];
  }
  if (!USER_SENDERS.has(envelope.payload.senderRole) || envelope.payload.assignedAdminUserId === null)
    return [];
  return [
    {
      recipient: { kind: 'user', id: idOf(envelope, 'assignedAdminUserId') },
      category: NotificationCategory.SUPPORT,
      type: NotificationType.SUPPORT_USER_MESSAGE,
      title: 'New message',
      body: `${ticketNumber} has a new message.`,
      link: NotificationLink.adminSupportTicket(ticketId),
    },
  ];
}

// As the DB CHECKs: 9 digits or more.
const RETURN_NUMBER_PATTERN = /^R-\d{9,}$/;
const ORDER_NUMBER_PATTERN = /^NM-\d{9,}$/;

function numberOf(envelope: EventEnvelope, key: string, pattern: RegExp): string {
  const value = envelope.payload[key];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new PermanentEventError(`${envelope.eventType} payload has no valid ${key}`);
  }
  return value;
}

/** Spec 13 §8.9: one row per listed status; the other moves notify nobody (the realtime message still goes). */
function returnStatusChanged(envelope: EventEnvelope): NotificationDraft[] {
  const returnId = idOf(envelope, 'returnId');
  const returnNumber = numberOf(envelope, 'returnNumber', RETURN_NUMBER_PATTERN);
  const toCustomer = (type: NotificationType, title: string, body: string): NotificationDraft => ({
    recipient: { kind: 'customer', id: idOf(envelope, 'customerId') },
    category: NotificationCategory.ORDERS,
    type,
    title,
    body,
    link: NotificationLink.customerReturn(returnId),
  });
  const toSeller = (type: NotificationType, title: string, body: string): NotificationDraft => ({
    recipient: { kind: 'seller', id: idOf(envelope, 'sellerId') },
    category: NotificationCategory.ORDERS,
    type,
    title,
    body,
    link: NotificationLink.sellerReturn(returnId),
  });
  const T = NotificationType;
  switch (envelope.payload.to) {
    case 'requested': {
      const orderNumber = numberOf(envelope, 'orderNumber', ORDER_NUMBER_PATTERN);
      return [
        toSeller(T.RETURN_REQUESTED, 'Return requested', `A return was requested on order #${orderNumber}.`),
      ];
    }
    case 'approved':
      return [
        toCustomer(
          T.RETURN_APPROVED,
          'Return approved',
          `Your return ${returnNumber} was approved. An agent will pick it up.`,
        ),
      ];
    case 'rejected':
      return [
        toCustomer(
          T.RETURN_REJECTED,
          'Return rejected',
          `Your return ${returnNumber} was rejected. You can escalate it.`,
        ),
      ];
    case 'picked_up':
      return [
        toCustomer(
          T.RETURN_PICKED_UP,
          'Return picked up',
          `Your return ${returnNumber} is on its way to the seller.`,
        ),
      ];
    case 'received':
      return [
        toSeller(
          T.RETURN_RECEIVED,
          'Return arrived',
          `Return ${returnNumber} was delivered to you. Please inspect it.`,
        ),
      ];
    case 'completed':
      return [
        toCustomer(
          T.RETURN_COMPLETED,
          'Return accepted',
          `Return ${returnNumber} is complete. Your refund is on its way.`,
        ),
      ];
    case 'refused': {
      const body = `Return ${returnNumber} was closed without a refund.`;
      return [
        toCustomer(T.RETURN_REFUSED, 'Return closed', body),
        toSeller(T.RETURN_REFUSED, 'Return closed', body),
      ];
    }
    default:
      return [];
  }
}
