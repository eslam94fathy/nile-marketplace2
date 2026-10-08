import { type Redis } from 'ioredis';
import { JwtVerifier } from './lib/auth';
import { type IClock, SystemClock } from './lib/clock';
import { type ApiEnv, type WorkerEnv } from './lib/config';
import { createKnex, Database } from './lib/db';
import { PgErrorMapper } from './lib/error';
import { OpenApiRegistry } from './lib/http';
import { type ILogger } from './lib/logger';
import { RateLimiters } from './lib/middleware';
import { createRedis } from './lib/redis';
import { type ICache, RedisCache } from './pkg/cache';
import { AesGcmSecretBox, type ISecretBox } from './pkg/crypto';
import { type IMessageBroker, RabbitMqBroker } from './pkg/messaging';
import { toSeconds, TimeUnit } from './pkg/time';

const BROKER_HEARTBEAT_SECONDS = toSeconds(30, TimeUnit.SECOND);

/** What every long-running process has. */
export interface CoreInfrastructure<E> {
  env: Readonly<E>;
  logger: ILogger;
  clock: IClock;
  db: Database;
  broker: IMessageBroker;
  pgErrorMapper: PgErrorMapper;
  secretBox: ISecretBox;
}

/** HTTP process: adds Redis (rate limits, idempotency, cache), token verification and API docs. */
export interface ApiInfrastructure extends CoreInfrastructure<ApiEnv> {
  redis: Redis;
  cache: ICache;
  jwtVerifier: JwtVerifier;
  rateLimiters: RateLimiters;
  openApi: OpenApiRegistry;
}

/** Background process: outbox drain, consumers, jobs. No Redis, no JWT, no HTTP. */
export type WorkerInfrastructure = CoreInfrastructure<WorkerEnv>;

type CoreEnv = Pick<
  ApiEnv,
  | 'DATABASE_URL'
  | 'DB_SSL'
  | 'DB_POOL_MIN'
  | 'DB_POOL_MAX'
  | 'DB_STATEMENT_TIMEOUT_MS'
  | 'SERVICE_NAME'
  | 'RABBITMQ_URL'
  | 'HEALTH_CHECK_TIMEOUT_MS'
  | 'SECRETS_ENCRYPTION_KEYS'
  | 'SECRETS_ENCRYPTION_ACTIVE_KEY_ID'
>;

/** A dependency that is down at boot is logged, not fatal: clients reconnect and readiness reports it. */
async function connectOrLog(logger: ILogger, name: string, connect: () => Promise<unknown>): Promise<void> {
  try {
    await connect();
  } catch (error) {
    logger.error('dependency unavailable at startup', { dependency: name, error });
  }
}

async function createCore<E extends CoreEnv>(
  env: Readonly<E>,
  logger: ILogger,
): Promise<CoreInfrastructure<E>> {
  const db = new Database(createKnex(env));
  const broker = new RabbitMqBroker({
    url: env.RABBITMQ_URL,
    heartbeatSeconds: BROKER_HEARTBEAT_SECONDS,
    publishTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
  });
  await Promise.all([
    connectOrLog(logger, 'postgres', () => db.ping()),
    connectOrLog(logger, 'rabbitmq', () => broker.connect(env.HEALTH_CHECK_TIMEOUT_MS)),
  ]);
  return {
    env,
    logger,
    clock: new SystemClock(),
    db,
    broker,
    pgErrorMapper: new PgErrorMapper(),
    secretBox: new AesGcmSecretBox({
      keys: env.SECRETS_ENCRYPTION_KEYS,
      activeKeyId: env.SECRETS_ENCRYPTION_ACTIVE_KEY_ID,
    }),
  };
}

export async function createApiInfrastructure(
  env: Readonly<ApiEnv>,
  logger: ILogger,
): Promise<ApiInfrastructure> {
  const redis = createRedis(env);
  // ioredis emits 'error' on every failed reconnect; log it instead of crashing.
  redis.on('error', (error: Error) => logger.warn('redis connection error', { error }));
  const [core] = await Promise.all([
    createCore(env, logger),
    connectOrLog(logger, 'redis', () => redis.connect()),
  ]);
  return {
    ...core,
    redis,
    cache: new RedisCache(redis),
    jwtVerifier: await JwtVerifier.create(env),
    rateLimiters: new RateLimiters(redis, env, logger),
    openApi: new OpenApiRegistry(),
  };
}

export function createWorkerInfrastructure(
  env: Readonly<WorkerEnv>,
  logger: ILogger,
): Promise<WorkerInfrastructure> {
  return createCore(env, logger);
}

/** Each close is independent, so one failure doesn't block the rest. */
export async function closeInfrastructure(infra: ApiInfrastructure | WorkerInfrastructure): Promise<void> {
  const closing: Promise<unknown>[] = [infra.broker.close(), infra.db.close()];
  if ('redis' in infra) closing.push(infra.redis.quit());
  const results = await Promise.allSettled(closing);
  for (const result of results) {
    if (result.status === 'rejected') {
      infra.logger.warn('error while closing a dependency', { error: result.reason });
    }
  }
}
