import { defineEvent } from './define-event';

/** Why every session of a user was revoked. Only a password reset publishes it (spec 03 §8.2). */
export type SessionsRevokedReasonValue = 'password_reset';

/** Publisher: identity (UC-ID-6 reset). Consumer: notifications (drops push subscriptions, NO-8). */
export interface UserSessionsRevokedPayload {
  userId: string;
  reason: SessionsRevokedReasonValue;
  /** ISO-8601. */
  revokedAt: string;
}

export const UserSessionsRevoked = defineEvent<UserSessionsRevokedPayload>(
  'user.sessions_revoked',
  1,
  'user',
);
