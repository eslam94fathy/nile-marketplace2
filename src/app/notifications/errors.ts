import { AppError } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** notifications error codes (docs/spec/13-notifications.md §8.6). */
export const NotificationsErrorCode = {
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',
} as const;

export const notificationNotFound = () =>
  new AppError(
    NotificationsErrorCode.NOTIFICATION_NOT_FOUND,
    'Notification not found',
    HTTP_STATUS.NOT_FOUND,
  );
