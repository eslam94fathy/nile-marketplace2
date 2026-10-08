import { type Redis } from 'ioredis';
import { type ICache } from './cache.interface';

export class RedisCache implements ICache {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    assertTtl(ttlSeconds);
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    assertTtl(ttlSeconds);
    return (await this.redis.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  delete(...keys: string[]): Promise<number> {
    return keys.length === 0 ? Promise.resolve(0) : this.redis.del(...keys);
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new RangeError(`TTL must be a positive whole number of seconds, got ${ttlSeconds}`);
  }
}
