import { type EmailTemplateName, type NotificationStatus } from '../enums';

/** One final outcome of a transactional email. Never contains the OTP or invite link. */
export interface NotificationLogEntry {
  userId: string | null;
  template: EmailTemplateName;
  toEmail: string;
  status: NotificationStatus;
  providerMessageId: string | null;
  error: string | null;
  sourceEventId: string;
}
