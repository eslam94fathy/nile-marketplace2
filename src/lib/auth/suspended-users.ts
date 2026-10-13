import { type ICache } from '../../pkg/cache';

/** Redis key of a suspended user's deny entry (architecture §8, spec 03 I-11). */
export const SUSPENDED_USER_KEY_PREFIX = 'auth:suspended:';
const BLOCKED = '1';

/**
 * Blocks the access tokens of a suspended user until they would have expired anyway (spec 03 I-11).
 * A JWT can't be revoked, so a suspension writes a deny entry that lives as long as an access token.
 */
export interface ISuspendedUsers {
  block(userId: string): Promise<void>;
  unblock(userId: string): Promise<void>;
  isBlocked(userId: string): Promise<boolean>;
}

export class SuspendedUsers implements ISuspendedUsers {
  constructor(
    private readonly cache: ICache,
    /** The access-token lifetime: every token issued before the suspension has expired after it. */
    private readonly ttlSeconds: number,
  ) {}

  block(userId: string): Promise<void> {
    return this.cache.set(`${SUSPENDED_USER_KEY_PREFIX}${userId}`, BLOCKED, this.ttlSeconds);
  }

  async unblock(userId: string): Promise<void> {
    await this.cache.delete(`${SUSPENDED_USER_KEY_PREFIX}${userId}`);
  }

  async isBlocked(userId: string): Promise<boolean> {
    return (await this.cache.get(`${SUSPENDED_USER_KEY_PREFIX}${userId}`)) !== null;
  }
}
