import 'reflect-metadata';
import { createServer } from 'node:http';
import express from 'express';
import helmet from 'helmet';
import { createHealthRouter, HEALTH_BASE_PATH } from './app/health';
import { ConnectLimiter, createRealtimeGateway } from './app/realtime';
import { createRealtimeContainer } from './container';
import { closeRealtimeInfrastructure, createRealtimeInfrastructure } from './infrastructure';
import { createLogger, createShutdown, installProcessHandlers, loadEnvOrExit } from './lib/bootstrap';
import { realtimeEnvSchema } from './lib/config';

/** Socket.IO gateway entrypoint (spec 15, RT-1): `node dist/realtime.js`, its own ECS service. */
async function main(): Promise<void> {
  const env = loadEnvOrExit('nile-realtime', realtimeEnvSchema);
  const logger = createLogger(env);
  const infra = await createRealtimeInfrastructure(env, logger);
  const container = createRealtimeContainer(infra);

  // Only the probes are HTTP; everything else is the socket (`/realtime`).
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(HEALTH_BASE_PATH, createHealthRouter(container));

  const server = createServer(app);
  const gateway = createRealtimeGateway(container, {
    env,
    logger,
    clock: infra.clock,
    jwtVerifier: infra.jwtVerifier,
    limiter: new ConnectLimiter(infra.redis, env, logger),
    adapterRedis: infra.adapterRedis,
  });
  gateway.attach(server);
  server.listen(env.PORT, () => logger.info('realtime gateway listening', { port: env.PORT }));

  // UC-RT-4: stop handshakes and close every socket with a reason, then the dependencies.
  const shutdown = createShutdown(logger, env.SHUTDOWN_TIMEOUT_MS, [
    { name: 'close sockets and stop accepting connections', run: () => gateway.close() },
    { name: 'close dependencies', run: () => closeRealtimeInfrastructure(infra) },
  ]);
  installProcessHandlers(logger, shutdown);
}

void main();
