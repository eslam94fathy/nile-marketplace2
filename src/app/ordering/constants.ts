export const ORDERING_TABLES = {
  ORDERS: 'orders',
  SELLER_ORDERS: 'seller_orders',
  ORDER_ITEMS: 'order_items',
  ORDER_ITEM_CANCELLATIONS: 'order_item_cancellations',
  ORDER_STATUS_HISTORY: 'order_status_history',
  SELLER_ORDER_STATUS_HISTORY: 'seller_order_status_history',
} as const;

/** Queue of the shipment consumer (docs/spec/02-events.md §2). */
export const SHIPMENT_UPDATES_QUEUE = 'ordering.shipment-updates';
/** Queue of the payment consumer (docs/spec/02-events.md §2). */
export const PAYMENT_UPDATES_QUEUE = 'ordering.payment-updates';

/** Paths under /api/v1 (spec 09 §4). */
export const ORDERING_PATHS = {
  CHECKOUT: '/checkout',
  ORDERS: '/orders',
  ORDER: '/orders/:orderId',
  KASHIER_SESSION: '/orders/:orderId/payment/kashier-session',
  SELLER_ORDERS: '/seller/orders',
  SELLER_ORDER: '/seller/orders/:sellerOrderId',
  CUSTOMER_CANCEL: '/orders/:orderId/seller-orders/:sellerOrderId/cancel',
  SELLER_ACCEPT: '/seller/orders/:sellerOrderId/accept',
  SELLER_READY: '/seller/orders/:sellerOrderId/ready',
  SELLER_CANCEL: '/seller/orders/:sellerOrderId/cancel',
  SELLER_ITEM_CANCEL: '/seller/orders/:sellerOrderId/items/:itemId/cancel',
  SELLER_RETURN_RECEIVED: '/seller/orders/:sellerOrderId/return-received',
  ADMIN_ORDERS: '/admin/orders',
  ADMIN_ORDER: '/admin/orders/:orderId',
  ADMIN_ORDER_CANCEL: '/admin/orders/:orderId/cancel',
  ADMIN_SELLER_ORDER_CANCEL: '/admin/seller-orders/:sellerOrderId/cancel',
} as const;

/** `order_status_history.reason` / `order_item_cancellations.note` are VARCHAR(500). */
export const NOTE_MAX_LENGTH = 500;

/** An admin cancel reason is 3..500 characters (spec 09 §8.4, OR-18). */
export const ADMIN_CANCEL_REASON_MIN = 3;

/** Mirrors `chk_order_items_quantity` (the cart's per-line limit, DB-Q3). */
export const ORDER_LINE_MAX_QUANTITY = 99;
