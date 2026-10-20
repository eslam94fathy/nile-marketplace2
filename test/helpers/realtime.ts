import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import express from 'express';
import { io as connect, type Socket } from 'socket.io-client';
import { createHealthRouter, HEALTH_BASE_PATH } from '../../src/app/health';
import {
  ConnectLimiter,
  createRealtimeGateway,
  REALTIME_PATH,
  type RealtimeGateway,
} from '../../src/app/realtime';
import { createRealtimeContainer } from '../../src/container';
import {
  closeRealtimeInfrastructure,
  createRealtimeInfrastructure,
  type RealtimeInfrastructure,
} from '../../src/infrastructure';
import { type RealtimeEnv } from '../../src/lib/config';
import { type RealtimeMessage } from '../../src/lib/realtime';
import { createMemoryLogger, type MemoryLogWriter } from './memory-logger';

export interface TestGateway {
  url: string;
  gateway: RealtimeGateway;
  infra: RealtimeInfrastructure;
  logs: MemoryLogWriter;
  /** Closes the gateway (sockets get `session.ended`), then its connections. */
  close(): Promise<void>;
}

/** One gateway task as `src/realtime.ts` builds it, on a free port of this machine. */
export async function startTestGateway(env: Readonly<RealtimeEnv>): Promise<TestGateway> {
  const { logger, writer } = createMemoryLogger();
  const infra = await createRealtimeInfrastructure(env, logger);
  const container = createRealtimeContainer(infra);
  const app = express();
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  let closed = false;
  return {
    url: `http://127.0.0.1:${port}`,
    gateway,
    infra,
    logs: writer,
    close: async () => {
      if (closed) return;
      closed = true;
      await gateway.close();
      await closeRealtimeInfrastructure(infra);
    },
  };
}

export interface TestSocket {
  socket: Socket;
  /** Every server message, in arrival order. */
  messages: RealtimeMessage[];
  of(type: string): RealtimeMessage[];
  /** Resolves with the disconnect reason Socket.IO reports. */
  disconnected: Promise<string>;
}

/** Connects like the web client: WebSocket only, `Origin` header, the access token in `auth`. */
export function connectSocket(
  url: string,
  options: { token?: string; origin?: string | null },
): Promise<TestSocket> {
  const socket = connect(url, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: options.token === undefined ? {} : { token: options.token },
    extraHeaders: options.origin ? { Origin: options.origin } : {},
  });
  const messages: RealtimeMessage[] = [];
  socket.onAny((_type: string, message: RealtimeMessage) => messages.push(message));
  const disconnected = new Promise<string>((resolve) => socket.on('disconnect', (reason) => resolve(reason)));
  return new Promise((resolve, reject) => {
    socket.once('connect', () =>
      resolve({ socket, messages, of: (type) => messages.filter((m) => m.type === type), disconnected }),
    );
    socket.once('connect_error', (error: Error & { data?: { code?: string } }) => {
      socket.close();
      reject(Object.assign(new Error(error.message), { code: error.data?.code }));
    });
  });
}

/** The connect error code a handshake ends with, or 'connected'. */
export async function connectErrorCode(url: string, options: { token?: string; origin?: string | null }) {
  try {
    const { socket } = await connectSocket(url, options);
    socket.close();
    return 'connected';
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
