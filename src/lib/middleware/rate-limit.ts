import { type Request, type RequestHandler } from 'express';
import { type Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { type Env } from '../config';
import { rateLimited, serviceUnavailable } from '../error/common-errors';
import { type ILogger } from '../logger';
import { HEADER } from './headers';

/** Rate-limit classes (docs/spec/01-api-conventions.md §7). */
export const RateLimitClass = {
  GENERAL: 'general',
  STRICT_AUTH: 'strict-auth',
  REFRESH: 'refresh',
  CHECKOUT: 'checkout',
} as const;
export type RateLimitClass = (typeof RateLimitClass)[keyof typeof RateLimitClass];

/** Sensitive classes fail closed when Redis is down; the rest fail open (architecture §8). */
const FAIL_CLOSED: ReadonlySet<RateLimitClass> = new Set([
  RateLimitClass.STRICT_AUTH,
  RateLimitClass.REFRESH,
  RateLimitClass.CHECKOUT,
]);

type RateEnv = Pick<
  Env,
  | 'RATE_LIMIT_GENERAL_POINTS'
  | 'RATE_LIMIT_GENERAL_WINDOW_SECONDS'
  | 'RATE_LIMIT_STRICT_AUTH_POINTS'
  | 'RATE_LIMIT_STRICT_AUTH_WINDOW_SECONDS'
  | 'RATE_LIMIT_REFRESH_POINTS'
  | 'RATE_LIMIT_REFRESH_WINDOW_SECONDS'
  | 'RATE_LIMIT_CHECKOUT_POINTS'
  | 'RATE_LIMIT_CHECKOUT_WINDOW_SECONDS'
>;

/** Builds the counter keys for a request: every key is limited separately (e.g. IP and email). */
export type RateLimitKeys = (req: Request) => readonly string[];

export const byIp: RateLimitKeys = (req) => [`ip:${req.ip ?? 'unknown'}`];

/** IP and the normalised `email` from the body: two independent counters (strict-auth). */
export const byIpAndEmail: RateLimitKeys = (req) => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.length > 0
    ? [...byIp(req), `email:${email.trim().toLowerCase()}`]
    : byIp(req);
};

/** The authenticated user (must run after `authenticate`), falling back to IP. */
export const byUser: RateLimitKeys = (req) => (req.auth ? [`user:${req.auth.userId}`] : byIp(req));

export class RateLimiters {
  private readonly limiters: ReadonlyMap<RateLimitClass, RateLimiterRedis>;

  constructor(
    redis: Redis,
    env: RateEnv,
    private readonly logger: ILogger,
  ) {
    const make = (cls: RateLimitClass, points: number, duration: number) =>
      [cls, new RateLimiterRedis({ storeClient: redis, keyPrefix: `rl:${cls}`, points, duration })] as const;
    this.limiters = new Map([
      make(RateLimitClass.GENERAL, env.RATE_LIMIT_GENERAL_POINTS, env.RATE_LIMIT_GENERAL_WINDOW_SECONDS),
      make(
        RateLimitClass.STRICT_AUTH,
        env.RATE_LIMIT_STRICT_AUTH_POINTS,
        env.RATE_LIMIT_STRICT_AUTH_WINDOW_SECONDS,
      ),
      make(RateLimitClass.REFRESH, env.RATE_LIMIT_REFRESH_POINTS, env.RATE_LIMIT_REFRESH_WINDOW_SECONDS),
      make(RateLimitClass.CHECKOUT, env.RATE_LIMIT_CHECKOUT_POINTS, env.RATE_LIMIT_CHECKOUT_WINDOW_SECONDS),
    ]);
  }

  /** Middleware for one class. Responds 429 + Retry-After when any key is over its limit. */
  limit(cls: RateLimitClass, keysOf: RateLimitKeys): RequestHandler {
    const limiter = this.limiters.get(cls);
    if (!limiter) throw new Error(`Unknown rate-limit class ${cls}`);
    return async (req, res, next) => {
      try {
        for (const key of keysOf(req)) await limiter.consume(key);
      } catch (rejection) {
        if (rejection instanceof RateLimiterRes) {
          res.setHeader(HEADER.RETRY_AFTER, String(Math.max(1, Math.ceil(rejection.msBeforeNext / 1000))));
          throw rateLimited();
        }
        this.logger.warn('rate limiter unavailable', { rateLimitClass: cls, error: rejection });
        if (FAIL_CLOSED.has(cls)) throw serviceUnavailable(rejection);
      }
      next();
    };
  }
}
