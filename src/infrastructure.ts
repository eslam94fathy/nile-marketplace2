import { Redis } from 'ioredis';
import { type ISuspendedUsers, JwtSigner, JwtVerifier, SuspendedUsers } from './lib/auth';
import { type IClock, SystemClock } from './lib/clock';
import {
  type ApiEnv,
  EmailProvider,
  type RealtimeEnv,
  PaymentGatewayName,
  StorageProvider,
  type WorkerEnv,
} from './lib/config';
import { createKnex, Database } from './lib/db';
import { PgErrorMapper } from './lib/error';
import { OpenApiRegistry } from './lib/http';
import { type ILogger } from './lib/logger';
import { RateLimiters } from './lib/middleware';
import { type IRealtimeEmitter, RedisRealtimeEmitter } from './lib/realtime';
import { createRedis } from './lib/redis';
import { type ICache, RedisCache } from './pkg/cache';
import { AesGcmSecretBox, type ISecretBox } from './pkg/crypto';
import { type IEmailSender, MailjetEmailSender, MailpitEmailSender } from './pkg/email';
import { FakePaymentGateway, type IPaymentGateway, KashierPaymentGateway } from './pkg/payments';
import { BcryptPasswordHasher, type IPasswordHasher } from './pkg/hashing';
import { type IImageProcessor, SharpImageProcessor } from './pkg/image';
import { type IMessageBroker, RabbitMqBroker } from './pkg/messaging';
import { type IPushSender, WebPushSender } from './pkg/push';
import { S3ObjectStorage } from './pkg/storage';
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
  paymentGateway: IPaymentGateway;
  redis: Redis;
  cache: ICache;
  jwtVerifier: JwtVerifier;
  /** Deny entries of suspended users, checked by `jwtVerifier` (spec 03 I-11). */
  suspendedUsers: ISuspendedUsers;
  jwtSigner: JwtSigner;
  passwordHasher: IPasswordHasher;
  rateLimiters: RateLimiters;
  openApi: OpenApiRegistry;
  /** The media bucket: presigning, upload checks, readiness (spec 14). */
  objectStorage: S3ObjectStorage;
}

/** Background process: outbox drain, consumers, jobs, email, the realtime fan-out. No JWT, no HTTP. */
export interface WorkerInfrastructure extends CoreInfrastructure<WorkerEnv> {
  /** Only for the realtime emitter (spec 15 §6); the worker caches nothing (spec 06 CA-8). */
  redis: Redis;
  realtimeEmitter: IRealtimeEmitter;
  /** Web Push to the users' browsers (spec 13 UC-NO-3). */
  pushSender: IPushSender;
  emailSender: IEmailSender;
  paymentGateway: IPaymentGateway;
  /** The media bucket: image processing and cleanup (spec 14 UC-ME-3, UC-ME-4). */
  objectStorage: S3ObjectStorage;
  imageProcessor: IImageProcessor;
}

/**
 * The Socket.IO gateway (spec 15): Postgres for profile lookups; Redis for the rate limit and the
 * suspended-user check, and two more connections for the adapter (a subscriber can run nothing else).
 * No broker, no storage, no signing key.
 */
export interface RealtimeInfrastructure {
  env: Readonly<RealtimeEnv>;
  logger: ILogger;
  clock: IClock;
  db: Database;
  redis: Redis;
  cache: ICache;
  adapterRedis: { pub: Redis; sub: Redis };
  jwtVerifier: JwtVerifier;
}

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
  const cache = new RedisCache(redis);
  const suspendedUsers = new SuspendedUsers(cache, toSeconds(env.ACCESS_TOKEN_TTL_MINUTES, TimeUnit.MINUTE));
  return {
    ...core,
    redis,
    cache,
    suspendedUsers,
    jwtVerifier: await JwtVerifier.create(env, {
      isBlocked: (userId) => suspendedUsers.isBlocked(userId),
      onBlockCheckError: (error) =>
        logger.warn('suspended-user check unavailable, request allowed', {
          event: 'SUSPENSION_CHECK_UNAVAILABLE',
          error,
        }),
    }),
    jwtSigner: await JwtSigner.create(env, core.clock),
    passwordHasher: new BcryptPasswordHasher(env.BCRYPT_COST),
    rateLimiters: new RateLimiters(redis, env, logger),
    openApi: new OpenApiRegistry(),
    paymentGateway: createPaymentGateway(env),
    objectStorage: createObjectStorage(env, env.STORAGE_PUBLIC_ENDPOINT),
  };
}

export async function createWorkerInfrastructure(
  env: Readonly<WorkerEnv>,
  logger: ILogger,
): Promise<WorkerInfrastructure> {
  const redis = createRedis(env);
  redis.on('error', (error: Error) => logger.warn('redis connection error', { error }));
  const [core] = await Promise.all([
    createCore(env, logger),
    connectOrLog(logger, 'redis', () => redis.connect()),
  ]);
  return {
    ...core,
    redis,
    realtimeEmitter: new RedisRealtimeEmitter(redis, env.REDIS_KEY_PREFIX, core.clock, logger),
    pushSender: new WebPushSender({
      vapidPublicKey: env.VAPID_PUBLIC_KEY,
      vapidPrivateKey: env.VAPID_PRIVATE_KEY,
      vapidSubject: env.VAPID_SUBJECT,
      timeoutMs: env.PUSH_HTTP_TIMEOUT_MS,
    }),
    emailSender: createEmailSender(env),
    paymentGateway: createPaymentGateway(env),
    objectStorage: createObjectStorage(env, undefined),
    imageProcessor: new SharpImageProcessor(),
  };
}

export async function createRealtimeInfrastructure(
  env: Readonly<RealtimeEnv>,
  logger: ILogger,
): Promise<RealtimeInfrastructure> {
  const db = new Database(createKnex(env));
  const redis = createRedis(env);
  // The adapter's connections queue commands while reconnecting (its subscriptions must survive a blip).
  const adapterRedis = {
    pub: new Redis(env.REDIS_URL, { lazyConnect: true, connectTimeout: env.HEALTH_CHECK_TIMEOUT_MS }),
    sub: new Redis(env.REDIS_URL, { lazyConnect: true, connectTimeout: env.HEALTH_CHECK_TIMEOUT_MS }),
  };
  for (const client of [redis, adapterRedis.pub, adapterRedis.sub]) {
    client.on('error', (error: Error) => logger.warn('redis connection error', { error }));
  }
  await Promise.all([
    connectOrLog(logger, 'postgres', () => db.ping()),
    connectOrLog(logger, 'redis', () => redis.connect()),
    connectOrLog(logger, 'redis-adapter-pub', () => adapterRedis.pub.connect()),
    connectOrLog(logger, 'redis-adapter-sub', () => adapterRedis.sub.connect()),
  ]);
  const cache = new RedisCache(redis);
  // The gateway only reads deny entries; the TTL is the api's business (it writes them).
  const suspendedUsers = new SuspendedUsers(cache, 1);
  return {
    env,
    logger,
    clock: new SystemClock(),
    db,
    redis,
    cache,
    adapterRedis,
    jwtVerifier: await JwtVerifier.create(env, {
      isBlocked: (userId) => suspendedUsers.isBlocked(userId),
      onBlockCheckError: (error) =>
        logger.warn('suspended-user check unavailable, connection allowed', {
          event: 'SUSPENSION_CHECK_UNAVAILABLE',
          error,
        }),
    }),
  };
}

/** Each close is independent, so one failure doesn't block the rest. */
export async function closeRealtimeInfrastructure(infra: RealtimeInfrastructure): Promise<void> {
  await settleAll(infra.logger, [
    infra.db.close(),
    infra.redis.quit(),
    infra.adapterRedis.pub.quit(),
    infra.adapterRedis.sub.quit(),
  ]);
}

type StorageEnv = Pick<
  WorkerEnv,
  | 'STORAGE_PROVIDER'
  | 'STORAGE_BUCKET'
  | 'STORAGE_REGION'
  | 'STORAGE_HTTP_TIMEOUT_MS'
  | 'STORAGE_ENDPOINT'
  | 'STORAGE_ACCESS_KEY_ID'
  | 'STORAGE_SECRET_ACCESS_KEY'
>;

/**
 * Spec 14 §6: S3 through the task role in AWS; MinIO locally and in tests with its endpoint and keys
 * (the env schema requires them). `publicEndpoint` signs the URLs browsers use (api only).
 */
export function createObjectStorage(
  env: Readonly<StorageEnv>,
  publicEndpoint: string | undefined,
): S3ObjectStorage {
  const common = {
    bucket: env.STORAGE_BUCKET,
    region: env.STORAGE_REGION,
    timeoutMs: env.STORAGE_HTTP_TIMEOUT_MS,
  };
  if (env.STORAGE_PROVIDER === StorageProvider.S3) return new S3ObjectStorage(common);
  if (!env.STORAGE_ENDPOINT || !env.STORAGE_ACCESS_KEY_ID || !env.STORAGE_SECRET_ACCESS_KEY) {
    throw new Error('MinIO storage configuration is incomplete');
  }
  return new S3ObjectStorage({
    ...common,
    endpoint: env.STORAGE_ENDPOINT,
    publicEndpoint,
    credentials: { accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY },
  });
}

/** P1-Q2: Mailjet in staging/production, Mailpit locally (the env schema enforces the required keys). */
export function createEmailSender(env: Readonly<WorkerEnv>): IEmailSender {
  const from = { email: env.MAILJET_FROM_EMAIL, name: env.MAILJET_FROM_NAME };
  if (env.EMAIL_PROVIDER === EmailProvider.MAILJET && env.MAILJET_API_KEY && env.MAILJET_SECRET_KEY) {
    return new MailjetEmailSender({
      apiKey: env.MAILJET_API_KEY,
      secretKey: env.MAILJET_SECRET_KEY,
      from,
      timeoutMs: env.EMAIL_HTTP_TIMEOUT_MS,
    });
  }
  if (env.EMAIL_PROVIDER === EmailProvider.MAILPIT && env.MAILPIT_URL) {
    return new MailpitEmailSender({ url: env.MAILPIT_URL, from, timeoutMs: env.EMAIL_HTTP_TIMEOUT_MS });
  }
  throw new Error('Email provider configuration is incomplete');
}

/** Where the fake's checkout links point: a reserved name that never resolves (RFC 2606). */
const FAKE_CHECKOUT_BASE_URL = 'https://fake-kashier.invalid';

/**
 * Spec 10 PA-5: Kashier in staging/production, the fake locally and in tests (the env schema
 * enforces which keys each needs). The worker only reads session statuses, which needs no credential
 * (PA-13), so its Kashier gateway has no secret key or merchant id.
 */
export function createPaymentGateway(
  env: Readonly<Partial<Omit<ApiEnv, keyof WorkerEnvPaymentKeys>> & WorkerEnvPaymentKeys>,
): IPaymentGateway {
  if (env.PAYMENT_GATEWAY === PaymentGatewayName.FAKE) {
    return new FakePaymentGateway({ apiKey: env.KASHIER_API_KEY, checkoutBaseUrl: FAKE_CHECKOUT_BASE_URL });
  }
  if (!env.KASHIER_BASE_URL) throw new Error('Kashier configuration is incomplete');
  return new KashierPaymentGateway({
    baseUrl: env.KASHIER_BASE_URL.replace(/\/+$/, ''),
    // Only the worker refunds; the schema requires it there (K-8).
    fepBaseUrl: env.KASHIER_FEP_BASE_URL?.replace(/\/+$/, '') ?? '',
    apiKey: env.KASHIER_API_KEY,
    // Only the api creates sessions; the schema requires these there. Both processes have the secret key.
    merchantId: env.KASHIER_MERCHANT_ID ?? '',
    secretKey: env.KASHIER_SECRET_KEY ?? '',
    webhookUrl: env.KASHIER_WEBHOOK_URL ?? '',
    redirectUrl: env.KASHIER_REDIRECT_URL ?? '',
    timeoutMs: env.KASHIER_HTTP_TIMEOUT_MS,
  });
}

type WorkerEnvPaymentKeys = Pick<
  WorkerEnv,
  'PAYMENT_GATEWAY' | 'KASHIER_API_KEY' | 'KASHIER_HTTP_TIMEOUT_MS' | 'KASHIER_BASE_URL'
> &
  Partial<Pick<WorkerEnv, 'KASHIER_FEP_BASE_URL' | 'KASHIER_SECRET_KEY'>>;

/** Each close is independent, so one failure doesn't block the rest. */
export async function closeInfrastructure(infra: ApiInfrastructure | WorkerInfrastructure): Promise<void> {
  infra.objectStorage.close();
  await settleAll(infra.logger, [infra.broker.close(), infra.db.close(), infra.redis.quit()]);
}

async function settleAll(logger: ILogger, closing: readonly Promise<unknown>[]): Promise<void> {
  for (const result of await Promise.allSettled(closing)) {
    if (result.status === 'rejected')
      logger.warn('error while closing a dependency', { error: result.reason });
  }
}
