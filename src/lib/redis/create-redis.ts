import { Redis } from 'ioredis';
import { type Env } from '../config';

/**
 * Redis is never a source of truth (architecture §1). Commands fail fast while disconnected
 * (no offline queue), so each caller can fail open or closed as its route requires (architecture §8).
 */
export function createRedis(
  env: Pick<Env, 'REDIS_URL' | 'REDIS_KEY_PREFIX' | 'HEALTH_CHECK_TIMEOUT_MS'>,
): Redis {
  return new Redis(env.REDIS_URL, {
    keyPrefix: env.REDIS_KEY_PREFIX,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: env.HEALTH_CHECK_TIMEOUT_MS,
  });
}
