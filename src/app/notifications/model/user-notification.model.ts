import { type NotificationCategory, type NotificationType } from '../enums';

export interface UserNotification {
  id: string;
  userId: string;
  category: NotificationCategory;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  sourceEventId: string;
  readAt: Date | null;
  createdAt: Date;
}

export type NewUserNotification = Omit<UserNotification, 'id' | 'readAt' | 'createdAt'>;

/** A user's push setting for one category, defaults filled in (spec 13 §8.4). */
export interface NotificationPreference {
  category: NotificationCategory;
  pushEnabled: boolean;
}
