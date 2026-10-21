import { toSeconds, TimeUnit } from '../../pkg/time';
import { NotificationCategory } from './enums';

export const NOTIFICATIONS_TABLES = {
  NOTIFICATION_LOG: 'notification_log',
  USER_NOTIFICATIONS: 'user_notifications',
  NOTIFICATION_PREFERENCES: 'notification_preferences',
  PUSH_SUBSCRIPTIONS: 'push_subscriptions',
} as const;

/** Queue of the email consumer (docs/spec/02-events.md §2). */
export const EMAIL_CONSUMER_QUEUE = 'notifications.email';

/** Queue of the push sender (spec 13 UC-NO-3, NO-6). */
export const PUSH_QUEUE = 'notifications.push';

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
  PUSH_CONFIG: '/push/config',
  PUSH_SUBSCRIPTIONS: '/me/push-subscriptions',
  PUSH_UNREGISTER: '/me/push-subscriptions/unregister',
} as const;

/** Column limits of `push_subscriptions` (spec 13 §8.1). */
export const PUSH_ENDPOINT_MAX_LENGTH = 2_048;
export const PUSH_P256DH_MAX_LENGTH = 100;
export const PUSH_AUTH_MAX_LENGTH = 50;
export const PUSH_USER_AGENT_MAX_LENGTH = 200;

/** A user's browsers; registering one more deletes the oldest (spec 13 §8.1). */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;

/** How long a push service keeps a message for an offline device (UC-NO-3 step 2). */
export const PUSH_TTL_SECONDS = toSeconds(24, TimeUnit.HOUR);

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
  /** NO-31 (spec 16 SU-14). */
  supportTicket: (ticketId: string) => `/support/tickets/${ticketId}`,
  adminSupportTicket: (ticketId: string) => `/admin/support/tickets/${ticketId}`,
  /** NO-32 (spec 17 RV-11): sellers have no single-review page. */
  sellerReviews: () => '/seller/reviews',
  myReview: (reviewId: string) => `/me/reviews/${reviewId}`,
} as const;
