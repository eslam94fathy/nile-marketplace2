import 'reflect-metadata';
import { createApp } from './http-app';
import { createApiContainer } from './container';
import { closeInfrastructure, createApiInfrastructure } from './infrastructure';
import { apiEnvSchema } from './lib/config';
import { createLogger, createShutdown, installProcessHandlers, loadEnvOrExit } from './lib/bootstrap';

/** HTTP entrypoint: `node dist/server.js`. */
async function main(): Promise<void> {
  const env = loadEnvOrExit('nile-api', apiEnvSchema);
  const logger = createLogger(env);
  const infra = await createApiInfrastructure(env, logger);
  const container = createApiContainer(infra);
  const app = createApp(infra, container);

  const server = app.listen(env.PORT, () => logger.info('http server listening', { port: env.PORT }));

  const shutdown = createShutdown(logger, env.SHUTDOWN_TIMEOUT_MS, [
    {
      name: 'stop accepting connections and drain in-flight requests',
      run: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        }),
    },
    { name: 'close dependencies', run: () => closeInfrastructure(infra) },
  ]);
  installProcessHandlers(logger, shutdown);
}

void main();
