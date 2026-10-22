/** Values match `chk_delivery_agents_status` (spec 11 §1). */
export const AgentStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

/** Values match `chk_shipments_status` (spec 11 §1.1). */
export const ShipmentStatus = {
  UNASSIGNED: 'unassigned',
  ASSIGNED: 'assigned',
  PICKED_UP: 'picked_up',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERY_FAILED: 'delivery_failed',
  RETURNING_TO_SELLER: 'returning_to_seller',
  RETURNED_TO_SELLER: 'returned_to_seller',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  /** Return shipments only: a failed pickup attempt with attempts left (spec 11 §8.1). */
  PICKUP_FAILED: 'pickup_failed',
} as const;
export type ShipmentStatus = (typeof ShipmentStatus)[keyof typeof ShipmentStatus];

/**
 * Values match `chk_shipments_kind` (spec 11 §8.1). The snapshot columns keep their party for both
 * kinds: pickup is the seller, drop-off the customer; a return runs from drop-off to pickup (DE-21).
 */
export const ShipmentKind = {
  DELIVERY: 'delivery',
  RETURN: 'return',
} as const;
export type ShipmentKind = (typeof ShipmentKind)[keyof typeof ShipmentKind];

/** The agent's open work: its load for assignment and the default agent list (spec 11 §1, DE-12). */
export const ACTIVE_SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  ShipmentStatus.ASSIGNED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.DELIVERY_FAILED,
  ShipmentStatus.RETURNING_TO_SELLER,
];

/** Values match `chk_shipment_attempts_reason` (overview §4.7). */
export const AttemptFailureReason = {
  CUSTOMER_UNREACHABLE: 'customer_unreachable',
  CUSTOMER_REFUSED: 'customer_refused',
  WRONG_ADDRESS: 'wrong_address',
  CUSTOMER_RESCHEDULED: 'customer_rescheduled',
} as const;
export type AttemptFailureReason = (typeof AttemptFailureReason)[keyof typeof AttemptFailureReason];

/** Values match the history `actor_role` CHECK. */
export const DeliveryActorRole = {
  ADMIN: 'admin',
  DELIVERY_AGENT: 'delivery_agent',
  SYSTEM: 'system',
} as const;
export type DeliveryActorRole = (typeof DeliveryActorRole)[keyof typeof DeliveryActorRole];
