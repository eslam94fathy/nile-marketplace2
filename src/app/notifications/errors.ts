import { AppError } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** notifications error codes (docs/spec/13-notifications.md §8.6). */
export const NotificationsErrorCode = {
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',
  PUSH_ENDPOINT_NOT_ALLOWED: 'PUSH_ENDPOINT_NOT_ALLOWED',
} as const;

export const notificationNotFound = () =>
  new AppError(
    NotificationsErrorCode.NOTIFICATION_NOT_FOUND,
    'Notification not found',
    HTTP_STATUS.NOT_FOUND,
  );

export const pushEndpointNotAllowed = () =>
  new AppError(
    NotificationsErrorCode.PUSH_ENDPOINT_NOT_ALLOWED,
    'This push service is not supported',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
  );
