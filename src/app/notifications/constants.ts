export const NOTIFICATIONS_TABLES = { NOTIFICATION_LOG: 'notification_log' } as const;

/** Queue of the email consumer (docs/spec/02-events.md §2). */
export const EMAIL_CONSUMER_QUEUE = 'notifications.email';

/** `notification_log.error` is VARCHAR(2000). */
export const LOG_ERROR_MAX_LENGTH = 2_000;

export const REDACTED = '[REDACTED]';
