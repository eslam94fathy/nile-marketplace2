import { type Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { type Env } from '../../../lib/config';
import { type ILogger } from '../../../lib/logger';
import { CONNECT_RATE_LIMIT_KEY_PREFIX } from '../constants';

type ConnectRateEnv = Pick<
  Env,
  'RATE_LIMIT_REALTIME_CONNECT_POINTS' | 'RATE_LIMIT_REALTIME_CONNECT_WINDOW_SECONDS'
>;

/**
 * Handshake rate limit, class `realtime-connect` (spec 15 UC-RT-1 step 2): by IP before the token is
 * read, then by user. Fails open like the general class: a socket only notifies (architecture §8).
 */
export class ConnectLimiter {
  private readonly limiter: RateLimiterRedis;

  constructor(
    redis: Redis,
    env: ConnectRateEnv,
    private readonly logger: ILogger,
  ) {
    this.limiter = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: CONNECT_RATE_LIMIT_KEY_PREFIX,
      points: env.RATE_LIMIT_REALTIME_CONNECT_POINTS,
      duration: env.RATE_LIMIT_REALTIME_CONNECT_WINDOW_SECONDS,
    });
  }

  /** False when the key is over its limit. */
  async allow(key: string): Promise<boolean> {
    try {
      await this.limiter.consume(key);
      return true;
    } catch (rejection) {
      if (rejection instanceof RateLimiterRes) return false;
      this.logger.warn('rate limiter unavailable', { rateLimitClass: 'realtime-connect', error: rejection });
      return true;
    }
  }
}

export const ipKey = (ip: string): string => `ip:${ip}`;
export const userKey = (userId: string): string => `user:${userId}`;
