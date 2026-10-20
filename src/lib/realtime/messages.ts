/**
 * The socket contract (spec 15 §3.1, conventions §9.3), documented in docs/realtime.md (RT-6).
 * Shared kernel like the event contracts: the realtime module emits most messages, and notifications
 * emits `notification.created` (spec 13), so neither may own it. Statuses use the REST enum values.
 */

/** Socket.IO event name = `type`; the payload is the whole envelope. */
export const RealtimeMessageType = {
  ORDER_UPDATED: 'order.updated',
  SELLER_ORDER_PLACED: 'seller_order.placed',
  SELLER_ORDER_UPDATED: 'seller_order.updated',
  SHIPMENT_UPDATED: 'shipment.updated',
  SHIPMENT_ASSIGNED: 'shipment.assigned',
  SHIPMENT_UNASSIGNED: 'shipment.unassigned',
  PAYMENT_UPDATED: 'payment.updated',
  MEDIA_UPDATED: 'media.updated',
  /** Sent just before the server closes the socket (RT-8). */
  SESSION_ENDED: 'session.ended',
} as const;
export type RealtimeMessageType = (typeof RealtimeMessageType)[keyof typeof RealtimeMessageType];

/** Why the server closes a socket (spec 15 §6). */
export const DisconnectReason = {
  TOKEN_EXPIRED: 'token_expired',
  SERVER_SHUTTING_DOWN: 'server_shutting_down',
  ACCOUNT_SUSPENDED: 'account_suspended',
} as const;
export type DisconnectReason = (typeof DisconnectReason)[keyof typeof DisconnectReason];

export interface RealtimeMessage<T extends RealtimeMessageType = RealtimeMessageType> {
  type: T;
  /** The source domain event; a random id for gateway-made messages (`session.ended`). */
  eventId: string;
  /** ISO-8601. */
  occurredAt: string;
  data: RealtimeMessageData[T];
}

/** `data` per message type: ids and statuses only, no PII (spec 15 §3.1). */
export interface RealtimeMessageData {
  [RealtimeMessageType.ORDER_UPDATED]: { orderId: string; orderNumber: string; status: string };
  [RealtimeMessageType.SELLER_ORDER_PLACED]: { sellerOrderId: string; orderNumber: string };
  [RealtimeMessageType.SELLER_ORDER_UPDATED]: { sellerOrderId: string; orderId: string; status: string };
  [RealtimeMessageType.SHIPMENT_UPDATED]: {
    shipmentId: string;
    sellerOrderId: string;
    orderId: string;
    status: string;
  };
  [RealtimeMessageType.SHIPMENT_ASSIGNED]: { shipmentId: string; sellerOrderId: string };
  [RealtimeMessageType.SHIPMENT_UNASSIGNED]: { shipmentId: string; sellerOrderId: string };
  [RealtimeMessageType.PAYMENT_UPDATED]: { orderId: string; paymentStatus: string };
  [RealtimeMessageType.MEDIA_UPDATED]: { mediaId: string; status: string };
  [RealtimeMessageType.SESSION_ENDED]: { reason: DisconnectReason };
}

/** Room names (spec 15 UC-RT-1 step 4). */
export const RealtimeRoom = {
  user: (userId: string) => `user:${userId}`,
  customer: (customerId: string) => `customer:${customerId}`,
  seller: (sellerId: string) => `seller:${sellerId}`,
  agent: (agentId: string) => `agent:${agentId}`,
  ADMINS: 'admins',
} as const;
