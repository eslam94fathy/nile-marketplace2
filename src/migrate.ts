import { createLogger, loadEnvOrExit } from './lib/bootstrap';
import { migrateEnvSchema } from './lib/config';
import { createKnex } from './lib/db';
import { migrateLatest, migrateRollback } from './lib/db/migrator';
import { MIGRATIONS } from './migrations';

/**
 * One-off migration runner: `node dist/migrate.js latest | rollback`.
 * Runs as its own container before a deploy takes traffic (architecture §13).
 */
const Command = { LATEST: 'latest', ROLLBACK: 'rollback' } as const;

async function main(): Promise<void> {
  const env = loadEnvOrExit('nile-migrate', migrateEnvSchema);
  const logger = createLogger(env).child({ component: 'migrate' });
  const command = process.argv[2];
  if (command !== Command.LATEST && command !== Command.ROLLBACK) {
    logger.fatal('unknown migrate command', { command, allowed: Object.values(Command) });
    process.exitCode = 1;
    return;
  }

  const knex = createKnex(env);
  const startedAt = Date.now();
  try {
    const names =
      command === Command.LATEST
        ? await migrateLatest(knex, MIGRATIONS)
        : await migrateRollback(knex, MIGRATIONS);
    logger.info('migrations finished', {
      command,
      migrations: names,
      count: names.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logger.fatal('migrations failed', { command, error });
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
}

void main();
