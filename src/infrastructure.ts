import { type Redis } from 'ioredis';
import { JwtVerifier } from './lib/auth';
import { type IClock, SystemClock } from './lib/clock';
import { type Env } from './lib/config';
import { createKnex, Database } from './lib/db';
import { PgErrorMapper } from './lib/error';
import { OpenApiRegistry } from './lib/http';
import { type ILogger } from './lib/logger';
import { RateLimiters } from './lib/middleware';
import { createRedis } from './lib/redis';
import { type ICache, RedisCache } from './pkg/cache';
import { type IMessageBroker, RabbitMqBroker } from './pkg/messaging';
import { toSeconds, TimeUnit } from './pkg/time';

const BROKER_HEARTBEAT_SECONDS = toSeconds(30, TimeUnit.SECOND);

/** Every long-lived infrastructure object of one process (api or worker). */
export interface Infrastructure {
  env: Readonly<Env>;
  logger: ILogger;
  clock: IClock;
  db: Database;
  redis: Redis;
  cache: ICache;
  broker: IMessageBroker;
  pgErrorMapper: PgErrorMapper;
  jwtVerifier: JwtVerifier;
  rateLimiters: RateLimiters;
  openApi: OpenApiRegistry;
}

/**
 * Connects Postgres, Redis and RabbitMQ. A dependency that is down at boot is logged, not fatal:
 * readiness reports it and the clients reconnect, so the process recovers without a restart.
 */
export async function createInfrastructure(env: Readonly<Env>, logger: ILogger): Promise<Infrastructure> {
  const db = new Database(createKnex(env));
  const redis = createRedis(env);
  // ioredis emits 'error' on every failed reconnect; log it instead of crashing.
  redis.on('error', (error: Error) => logger.warn('redis connection error', { error }));
  const broker = new RabbitMqBroker({
    url: env.RABBITMQ_URL,
    heartbeatSeconds: BROKER_HEARTBEAT_SECONDS,
    publishTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
  });

  const connect = async (name: string, connectFn: () => Promise<unknown>) => {
    try {
      await connectFn();
    } catch (error) {
      logger.error('dependency unavailable at startup', { dependency: name, error });
    }
  };
  await Promise.all([
    connect('postgres', () => db.ping()),
    connect('redis', () => redis.connect()),
    connect('rabbitmq', () => broker.connect(env.HEALTH_CHECK_TIMEOUT_MS)),
  ]);

  return {
    env,
    logger,
    clock: new SystemClock(),
    db,
    redis,
    cache: new RedisCache(redis),
    broker,
    pgErrorMapper: new PgErrorMapper(),
    jwtVerifier: await JwtVerifier.create(env),
    rateLimiters: new RateLimiters(redis, env, logger),
    openApi: new OpenApiRegistry(),
  };
}

/** Closes in reverse dependency order; each close is independent so one failure doesn't block the rest. */
export async function closeInfrastructure(infra: Infrastructure): Promise<void> {
  const results = await Promise.allSettled([infra.broker.close(), infra.redis.quit(), infra.db.close()]);
  for (const result of results) {
    if (result.status === 'rejected')
      infra.logger.warn('error while closing a dependency', { error: result.reason });
  }
}
