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
