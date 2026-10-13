import { type Redis } from 'ioredis';
import { type ISuspendedUsers, JwtSigner, JwtVerifier, SuspendedUsers } from './lib/auth';
import { type IClock, SystemClock } from './lib/clock';
import { type ApiEnv, EmailProvider, PaymentGatewayName, type WorkerEnv } from './lib/config';
import { createKnex, Database } from './lib/db';
import { PgErrorMapper } from './lib/error';
import { OpenApiRegistry } from './lib/http';
import { type ILogger } from './lib/logger';
import { RateLimiters } from './lib/middleware';
import { createRedis } from './lib/redis';
import { type ICache, RedisCache } from './pkg/cache';
import { AesGcmSecretBox, type ISecretBox } from './pkg/crypto';
import { type IEmailSender, MailjetEmailSender, MailpitEmailSender } from './pkg/email';
import { FakePaymentGateway, type IPaymentGateway, KashierPaymentGateway } from './pkg/payments';
import { BcryptPasswordHasher, type IPasswordHasher } from './pkg/hashing';
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
}

/** Background process: outbox drain, consumers, jobs, email. No Redis, no JWT, no HTTP. */
export interface WorkerInfrastructure extends CoreInfrastructure<WorkerEnv> {
  emailSender: IEmailSender;
  paymentGateway: IPaymentGateway;
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
  };
}

export async function createWorkerInfrastructure(
  env: Readonly<WorkerEnv>,
  logger: ILogger,
): Promise<WorkerInfrastructure> {
  return {
    ...(await createCore(env, logger)),
    emailSender: createEmailSender(env),
    paymentGateway: createPaymentGateway(env),
  };
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
export function createPaymentGateway(env: Readonly<Partial<ApiEnv> & WorkerEnvPaymentKeys>): IPaymentGateway {
  if (env.PAYMENT_GATEWAY === PaymentGatewayName.FAKE) {
    return new FakePaymentGateway({ apiKey: env.KASHIER_API_KEY, checkoutBaseUrl: FAKE_CHECKOUT_BASE_URL });
  }
  if (!env.KASHIER_BASE_URL) throw new Error('Kashier configuration is incomplete');
  return new KashierPaymentGateway({
    baseUrl: env.KASHIER_BASE_URL.replace(/\/+$/, ''),
    apiKey: env.KASHIER_API_KEY,
    // Only the api creates sessions; the schema requires these there.
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
>;

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
