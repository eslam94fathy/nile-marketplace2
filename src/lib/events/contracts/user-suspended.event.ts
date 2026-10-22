import { defineEvent } from './define-event';
import { type UserRoleValue } from './shared-types';

/** Publisher: identity (every suspension, spec 03 §8.2). Consumers: realtime, notifications. */
export interface UserSuspendedPayload {
  userId: string;
  role: UserRoleValue;
  /** ISO-8601. */
  suspendedAt: string;
}

export const UserSuspended = defineEvent<UserSuspendedPayload>('user.suspended', 1, 'user');
