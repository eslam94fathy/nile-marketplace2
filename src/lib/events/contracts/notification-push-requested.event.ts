import { defineEvent } from './define-event';

/**
 * Publisher: notifications (UC-NO-2, a new in-app row whose category the user hasn't muted for push).
 * Consumer: notifications (`notifications.push`, UC-NO-3). Internal to the module (NO-6).
 */
export interface NotificationPushRequestedPayload {
  notificationId: string;
  userId: string;
}

export const NotificationPushRequested = defineEvent<NotificationPushRequestedPayload>(
  'notification.push_requested',
  1,
  'user_notification',
);
