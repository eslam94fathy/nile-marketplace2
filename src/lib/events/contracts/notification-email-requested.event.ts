import { defineEvent } from './define-event';
import { type UserRoleValue } from './shared-types';

export type EmailTemplate = 'email_verification' | 'password_reset' | 'account_invite';

/** Publisher: identity. Consumer: notifications. Secrets travel only in `encryptedSecrets` (S-1). */
export interface NotificationEmailRequestedPayload {
  template: EmailTemplate;
  userId: string;
  toEmail: string;
  variables: { expiresInMinutes: number } | { role: UserRoleValue; expiresAt: string };
  /** AES-256-GCM sealed `{ otp }` or `{ inviteUrl }`; AAD = `${userId}:${template}`. */
  encryptedSecrets: string;
}

export const NotificationEmailRequested = defineEvent<NotificationEmailRequestedPayload>(
  'notification.email_requested',
  1,
  'user',
);
