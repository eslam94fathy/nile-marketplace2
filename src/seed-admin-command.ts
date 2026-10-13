import { container as rootContainer } from 'tsyringe';
import { inviteFirstAdmin } from './app/identity';
import { SystemClock } from './lib/clock';
import { type SeedAdminEnv } from './lib/config';
import { createKnex, Database } from './lib/db';
import { TOKENS } from './lib/di';
import { isAppError, PgErrorMapper } from './lib/error';
import { Outbox } from './lib/events';
import { type ILogger } from './lib/logger';
import { AesGcmSecretBox } from './pkg/crypto';

const EMAIL_FLAG = '--email';

/** `--email a@b.c` or `--email=a@b.c`. */
export function parseEmailArg(argv: readonly string[]): string | undefined {
  for (const [index, arg] of argv.entries()) {
    if (arg === EMAIL_FLAG) return argv[index + 1];
    if (arg.startsWith(`${EMAIL_FLAG}=`)) return arg.slice(EMAIL_FLAG.length + 1);
  }
  return undefined;
}

/**
 * UC-ID-8 / P1-Q7: creates the first (invited) admin and writes the invite email to the outbox;
 * the worker sends it. Returns the exit code. Never prints the invite token.
 */
export async function runSeedAdmin(
  argv: readonly string[],
  env: Readonly<SeedAdminEnv>,
  logger: ILogger,
): Promise<number> {
  const email = parseEmailArg(argv);
  if (!email) {
    logger.fatal('usage: seed-admin --email <email>');
    return 1;
  }

  const clock = new SystemClock();
  const db = new Database(createKnex(env));
  const pgErrorMapper = new PgErrorMapper();
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.Env, { useValue: env });
  container.register(TOKENS.Logger, { useValue: logger });
  container.register(TOKENS.Clock, { useValue: clock });
  container.register(TOKENS.Database, { useValue: db });
  container.register(TOKENS.TransactionRunner, { useValue: db });
  container.register(TOKENS.PgErrorMapper, { useValue: pgErrorMapper });
  container.register(TOKENS.SecretBox, {
    useValue: new AesGcmSecretBox({
      keys: env.SECRETS_ENCRYPTION_KEYS,
      activeKeyId: env.SECRETS_ENCRYPTION_ACTIVE_KEY_ID,
    }),
  });
  container.register(TOKENS.Outbox, { useValue: new Outbox(clock) });

  try {
    const { userId } = await inviteFirstAdmin(container, email);
    logger.info('admin invited; the worker sends the invite email', { event: 'ADMIN_SEEDED', userId });
    return 0;
  } catch (caught) {
    const error = pgErrorMapper.map(caught) ?? caught;
    if (isAppError(error)) {
      logger.fatal('seed-admin refused', { code: error.code, details: error.details });
    } else {
      logger.fatal('seed-admin failed', { error });
    }
    return 1;
  } finally {
    await db.close();
  }
}
