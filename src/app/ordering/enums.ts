/** Values match `chk_orders_status` (spec 09 §1.1). Derived from the seller orders and stored. */
export const OrderStatus = {
  PENDING_PAYMENT: 'pending_payment',
  PLACED: 'placed',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  PARTIALLY_COMPLETED: 'partially_completed',
  CANCELLED: 'cancelled',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** Values match `chk_seller_orders_status` and the `SellerOrderStatus` event type (spec 09 §1.1). */
export const SellerOrderStatus = {
  PENDING_PAYMENT: 'pending_payment',
  PLACED: 'placed',
  ACCEPTED: 'accepted',
  READY_FOR_PICKUP: 'ready_for_pickup',
  PICKED_UP: 'picked_up',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERY_FAILED: 'delivery_failed',
  RETURNING_TO_SELLER: 'returning_to_seller',
  RETURNED_TO_SELLER: 'returned_to_seller',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
} as const;
export type SellerOrderStatus = (typeof SellerOrderStatus)[keyof typeof SellerOrderStatus];

/** Values match `chk_seller_orders_cancel_reason`. */
export const SellerOrderCancelReason = {
  CUSTOMER_CANCELLED: 'customer_cancelled',
  SELLER_CANCELLED: 'seller_cancelled',
  SELLER_ACCEPTANCE_TIMEOUT: 'seller_acceptance_timeout',
  PAYMENT_FAILED: 'payment_failed',
  PAYMENT_EXPIRED: 'payment_expired',
} as const;
export type SellerOrderCancelReason = (typeof SellerOrderCancelReason)[keyof typeof SellerOrderCancelReason];

/** Values match `chk_order_item_cancellations_reason` (spec 09 §4.2). */
export const ItemCancelReason = {
  OUT_OF_STOCK: 'out_of_stock',
  SELLER_REQUEST: 'seller_request',
  OTHER: 'other',
} as const;
export type ItemCancelReason = (typeof ItemCancelReason)[keyof typeof ItemCancelReason];

/** Values match the history tables' `actor_role` CHECK. */
export const ActorRole = {
  CUSTOMER: 'customer',
  SELLER: 'seller',
  ADMIN: 'admin',
  DELIVERY_AGENT: 'delivery_agent',
  SYSTEM: 'system',
} as const;
export type ActorRole = (typeof ActorRole)[keyof typeof ActorRole];
