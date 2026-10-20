/** Values match `chk_notification_log_status`. */
export const NotificationStatus = { SENT: 'sent', FAILED: 'failed' } as const;
export type NotificationStatus = (typeof NotificationStatus)[keyof typeof NotificationStatus];

/** Values match `chk_notification_log_template` and the `notification.email_requested` contract. */
export const EmailTemplateName = {
  EMAIL_VERIFICATION: 'email_verification',
  PASSWORD_RESET: 'password_reset',
  ACCOUNT_INVITE: 'account_invite',
} as const;
export type EmailTemplateName = (typeof EmailTemplateName)[keyof typeof EmailTemplateName];

/** Values match `chk_user_notifications_category` and `chk_notification_preferences_category` (R-6). */
export const NotificationCategory = {
  ORDERS: 'orders',
  SHIPMENTS: 'shipments',
  SUPPORT: 'support',
  PROMOTIONS: 'promotions',
} as const;
export type NotificationCategory = (typeof NotificationCategory)[keyof typeof NotificationCategory];

/** Values match `chk_user_notifications_type`: spec 13 §8.2, §8.8, §8.9 (later phases send the rest). */
export const NotificationType = {
  ORDER_PLACED: 'order_placed',
  SELLER_ORDER_RECEIVED: 'seller_order_received',
  SELLER_ORDER_ACCEPTED: 'seller_order_accepted',
  SELLER_ORDER_CANCELLED: 'seller_order_cancelled',
  PAYMENT_FAILED: 'payment_failed',
  SHIPMENT_ASSIGNED: 'shipment_assigned',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERY_ATTEMPT_FAILED: 'delivery_attempt_failed',
  DELIVERED: 'delivered',
  SUPPORT_REPLY: 'support_reply',
  SUPPORT_USER_MESSAGE: 'support_user_message',
  SUPPORT_RESOLVED: 'support_resolved',
  REVIEW_RECEIVED: 'review_received',
  REVIEW_REPLIED: 'review_replied',
  PRODUCT_BLOCKED: 'product_blocked',
  RETURN_REQUESTED: 'return_requested',
  RETURN_APPROVED: 'return_approved',
  RETURN_REJECTED: 'return_rejected',
  RETURN_PICKED_UP: 'return_picked_up',
  RETURN_RECEIVED: 'return_received',
  RETURN_COMPLETED: 'return_completed',
  RETURN_REFUSED: 'return_refused',
  REFUND_ISSUED: 'refund_issued',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];
