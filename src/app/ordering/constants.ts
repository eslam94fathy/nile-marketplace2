export const ORDERING_TABLES = {
  ORDERS: 'orders',
  SELLER_ORDERS: 'seller_orders',
  ORDER_ITEMS: 'order_items',
  ORDER_ITEM_CANCELLATIONS: 'order_item_cancellations',
  ORDER_STATUS_HISTORY: 'order_status_history',
  SELLER_ORDER_STATUS_HISTORY: 'seller_order_status_history',
} as const;

/** Paths under /api/v1 (spec 09 §4). */
export const ORDERING_PATHS = {
  CHECKOUT: '/checkout',
  ORDERS: '/orders',
  ORDER: '/orders/:orderId',
  SELLER_ORDERS: '/seller/orders',
  SELLER_ORDER: '/seller/orders/:sellerOrderId',
  ADMIN_ORDERS: '/admin/orders',
  ADMIN_ORDER: '/admin/orders/:orderId',
} as const;

/** `order_status_history.reason` / `order_item_cancellations.note` are VARCHAR(500). */
export const NOTE_MAX_LENGTH = 500;
