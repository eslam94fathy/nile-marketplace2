import 'reflect-metadata';
import { createWorkerContainer } from './container';
import { createEventHandlers } from './event-handlers';
import { closeInfrastructure, createWorkerInfrastructure } from './infrastructure';
import { workerEnvSchema } from './lib/config';
import { createLogger, createShutdown, installProcessHandlers, loadEnvOrExit } from './lib/bootstrap';
import { EventConsumerHost, OutboxDrainer } from './lib/events';
import { createCleanupJobs, JobRunner } from './lib/jobs';

/** Background entrypoint: `node dist/worker.js` (outbox drain, event consumers, scheduled jobs). */
async function main(): Promise<void> {
  const env = loadEnvOrExit('nile-worker', workerEnvSchema);
  const logger = createLogger(env);
  const infra = await createWorkerInfrastructure(env, logger);
  const container = createWorkerContainer(infra);
  const knex = infra.db.knex;

  const jobs = new JobRunner(knex, infra.clock, logger);
  const shutdown = createShutdown(logger, env.SHUTDOWN_TIMEOUT_MS, [
    { name: 'stop scheduled jobs', run: () => jobs.stop() },
    // Closing the broker cancels consumers and waits for in-flight handlers before disconnecting.
    { name: 'close dependencies', run: () => closeInfrastructure(infra) },
  ]);
  installProcessHandlers(logger, shutdown);

  await infra.broker.assertExchange(env.RABBITMQ_EXCHANGE);

  const consumers = new EventConsumerHost(infra.broker, infra.db, logger, env);
  for (const handler of createEventHandlers(container)) await consumers.start(handler);

  const drainer = new OutboxDrainer(knex, infra.broker, infra.clock, logger.child({ component: 'outbox' }), {
    exchange: env.RABBITMQ_EXCHANGE,
    batchSize: env.OUTBOX_BATCH_SIZE,
    maxBackoffMs: env.OUTBOX_MAX_BACKOFF_MS,
  });
  jobs.register({
    name: 'outbox-drain',
    intervalMs: env.OUTBOX_DRAIN_INTERVAL_MS,
    run: () => drainer.drainOnce(),
  });
  for (const job of createCleanupJobs(knex, infra.clock, env)) jobs.register(job);
  jobs.start();

  logger.info('worker started');
}

void main();
