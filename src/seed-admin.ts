import 'reflect-metadata';
import { createLogger, loadEnvOrExit } from './lib/bootstrap';
import { seedAdminEnvSchema } from './lib/config';
import { runSeedAdmin } from './seed-admin-command';

/** First-admin CLI: `node dist/seed-admin.js --email <email>` (P1-Q7, spec 03 UC-ID-8). */
async function main(): Promise<void> {
  const env = loadEnvOrExit('nile-seed-admin', seedAdminEnvSchema);
  const logger = createLogger(env).child({ component: 'seed-admin' });
  process.exitCode = await runSeedAdmin(process.argv.slice(2), env, logger);
}

void main();
