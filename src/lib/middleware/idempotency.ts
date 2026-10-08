import { type Request, type RequestHandler, type Response } from 'express';
import { type ICache } from '../../pkg/cache';
import { sha256Hex } from '../../pkg/crypto';
import { toSeconds, TimeUnit } from '../../pkg/time';
import { type Env } from '../config';
import {
  idempotencyKeyRequired,
  idempotencyKeyReused,
  idempotencyRequestInProgress,
  serviceUnavailable,
  unauthenticated,
} from '../error/common-errors';
import { HTTP_STATUS } from '../http/status-codes';
import { type ILogger } from '../logger';
import { HEADER, UUID_ANY_VERSION } from './headers';
import { routeTemplate } from '../http/route-template';

type IdempotencyEnv = Pick<Env, 'IDEMPOTENCY_TTL_HOURS' | 'IDEMPOTENCY_LOCK_TTL_SECONDS'>;

type StoredState =
  | { state: 'in_progress'; fingerprint: string }
  | { state: 'completed'; fingerprint: string; status: number; body: unknown };

/** Stable JSON: object keys sorted, so `{a,b}` and `{b,a}` fingerprint the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprintOf(req: Request, res: Response): string {
  return sha256Hex(`${req.method} ${routeTemplate(req, res)} ${canonicalJson(req.body ?? null)}`);
}

/**
 * G25 / CLAUDE.md §10. Must run after `authenticate` (keys are scoped per user).
 * - missing/invalid key → 400 · concurrent duplicate → 409 · completed duplicate → replay status + body
 * - same key, different request → 422 · 5xx responses release the key so the client can retry
 * Fails closed: these routes move money or stock.
 */
export function requireIdempotency(cache: ICache, env: IdempotencyEnv, logger: ILogger): RequestHandler {
  const ttlSeconds = toSeconds(env.IDEMPOTENCY_TTL_HOURS, TimeUnit.HOUR);

  return async (req, res, next) => {
    const key = req.get(HEADER.IDEMPOTENCY_KEY);
    if (!key || !UUID_ANY_VERSION.test(key)) throw idempotencyKeyRequired();
    if (!req.auth) throw unauthenticated();

    const storeKey = `idem:${req.auth.userId}:${key.toLowerCase()}`;
    const fingerprint = fingerprintOf(req, res);

    let locked: boolean;
    let existingRaw: string | null = null;
    try {
      const lock: StoredState = { state: 'in_progress', fingerprint };
      locked = await cache.setIfAbsent(storeKey, JSON.stringify(lock), env.IDEMPOTENCY_LOCK_TTL_SECONDS);
      if (!locked) existingRaw = await cache.get(storeKey);
    } catch (error) {
      throw serviceUnavailable(error);
    }

    if (!locked) {
      // The lock expired between SET NX and GET: treat it as still in progress, the client retries.
      if (existingRaw === null) throw idempotencyRequestInProgress();
      const existing = JSON.parse(existingRaw) as StoredState;
      if (existing.fingerprint !== fingerprint) throw idempotencyKeyReused();
      if (existing.state === 'in_progress') throw idempotencyRequestInProgress();
      res.setHeader(HEADER.IDEMPOTENT_REPLAYED, 'true');
      if (existing.body === null) res.status(existing.status).end();
      else res.status(existing.status).json(existing.body);
      return;
    }

    captureAndStore(res, async (status, body) => {
      try {
        if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR) {
          await cache.delete(storeKey);
          return;
        }
        const completed: StoredState = { state: 'completed', fingerprint, status, body };
        await cache.set(storeKey, JSON.stringify(completed), ttlSeconds);
      } catch (error) {
        // The response is still correct; the lock simply expires and a retry is re-executed.
        logger.error('idempotency result could not be stored', { error, statusCode: status });
      }
    });
    next();
  };
}

/**
 * Stores the outcome BEFORE the body is sent, so a client that retries right after
 * receiving the response gets a replay, not a 409.
 */
function captureAndStore(res: Response, store: (status: number, body: unknown) => Promise<void>): void {
  const originalJson = res.json.bind(res);
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response;
  let stored = false;

  res.json = ((body: unknown) => {
    stored = true;
    void store(res.statusCode, body).finally(() => originalJson(body));
    return res;
  }) as Response['json'];

  res.end = ((...args: unknown[]) => {
    if (stored) return originalEnd(...args);
    stored = true;
    void store(res.statusCode, null).finally(() => originalEnd(...args));
    return res;
  }) as Response['end'];
}
