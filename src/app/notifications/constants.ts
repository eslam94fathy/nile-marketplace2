import { NotificationCategory } from './enums';

export const NOTIFICATIONS_TABLES = {
  NOTIFICATION_LOG: 'notification_log',
  USER_NOTIFICATIONS: 'user_notifications',
  NOTIFICATION_PREFERENCES: 'notification_preferences',
} as const;

/** Queue of the email consumer (docs/spec/02-events.md §2). */
export const EMAIL_CONSUMER_QUEUE = 'notifications.email';

/** Queue of the notification-centre consumer (spec 13 UC-NO-2). */
export const USER_EVENTS_QUEUE = 'notifications.user-events';

/** `notification_log.error` is VARCHAR(2000). */
export const LOG_ERROR_MAX_LENGTH = 2_000;

export const REDACTED = '[REDACTED]';

/** Paths under /api/v1 (spec 13 §8.4). */
export const NOTIFICATION_PATHS = {
  LIST: '/me/notifications',
  UNREAD_COUNT: '/me/notifications/unread-count',
  READ: '/me/notifications/:notificationId/read',
  READ_ALL: '/me/notifications/read-all',
  PREFERENCES: '/me/notification-preferences',
} as const;

/** `GET /me/notifications/unread-count` counts up to this (a badge shows "99+"). */
export const UNREAD_COUNT_CAP = 100;

/** Push on unless the user changed it; `promotions` off (R-6). A code constant, not a DB default (G13). */
export const DEFAULT_PUSH_ENABLED: Readonly<Record<NotificationCategory, boolean>> = {
  [NotificationCategory.ORDERS]: true,
  [NotificationCategory.SHIPMENTS]: true,
  [NotificationCategory.SUPPORT]: true,
  [NotificationCategory.PROMOTIONS]: false,
};

/** The client routes a notification opens (NO-12). */
export const NotificationLink = {
  customerOrder: (orderId: string) => `/orders/${orderId}`,
  sellerOrder: (sellerOrderId: string) => `/seller/orders/${sellerOrderId}`,
  agentShipment: (shipmentId: string) => `/agent/shipments/${shipmentId}`,
} as const;
