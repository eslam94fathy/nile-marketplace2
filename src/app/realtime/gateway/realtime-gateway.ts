import { randomUUID } from 'node:crypto';
import { type Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { type Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { type JwtVerifier } from '../../../lib/auth';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type ILogger } from '../../../lib/logger';
import {
  DisconnectReason,
  type RealtimeMessage,
  RealtimeMessageType,
  realtimeChannelKey,
} from '../../../lib/realtime';
import {
  MAX_INBOUND_BYTES,
  MAX_TIMER_DELAY_MS,
  REALTIME_PATH,
  SHUTDOWN_SOCKET_DRAIN_MS,
  SIGNAL_WINDOW_MS,
} from '../constants';
import { AckErrorCode, ConnectError, connectError, ConnectErrorCode } from '../errors';
import { type ConnectLimiter, ipKey, userKey } from '../service/connect-limiter';
import { type ProfileRoomsService } from '../service/profile-rooms.service';
import { clientIp } from './client-ip';

type GatewayEnv = Pick<
  Env,
  'CORS_ALLOWED_ORIGINS' | 'TRUST_PROXY_HOPS' | 'REDIS_KEY_PREFIX' | 'REALTIME_SIGNAL_RATE_PER_SECOND'
>;

export interface RealtimeGatewayDeps {
  env: GatewayEnv;
  logger: ILogger;
  clock: IClock;
  jwtVerifier: JwtVerifier;
  limiter: ConnectLimiter;
  profileRooms: ProfileRoomsService;
  /** The adapter's publisher and subscriber connections (a subscriber can't run other commands). */
  adapterRedis: { pub: Redis; sub: Redis };
}

/** What the handshake established, kept on `socket.data`. */
interface SessionData {
  userId: string;
  role: string;
  rooms: string[];
  expiresAt: Date;
}

/** Client → server signals the gateway handles (spec 15 §3.3). Support's arrive with spec 16 (RT-10). */
const KNOWN_SIGNALS: ReadonlySet<string> = new Set();

/**
 * The Socket.IO gateway (spec 15 UC-RT-1, §3.3, UC-RT-4): WebSocket transport only, origin and token
 * checked at the handshake, one room per user and one per profile, a disconnect when the token expires.
 * A notification channel only: clients never write through it.
 */
export class RealtimeGateway {
  private readonly io: Server;
  private closing = false;

  constructor(private readonly deps: RealtimeGatewayDeps) {
    this.io = new Server({
      path: REALTIME_PATH,
      transports: ['websocket'],
      serveClient: false,
      maxHttpBufferSize: MAX_INBOUND_BYTES,
      adapter: createAdapter(deps.adapterRedis.pub, deps.adapterRedis.sub, {
        key: realtimeChannelKey(deps.env.REDIS_KEY_PREFIX),
      }),
    });
    this.io.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (error: unknown) => next(this.asConnectError(error)),
      );
    });
    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  attach(server: HttpServer): void {
    this.io.attach(server);
  }

  /**
   * UC-RT-4: refuse new handshakes, tell every local socket why it closes, then close the server
   * (and the HTTP server it is attached to). Clients reconnect to another task.
   */
  async close(): Promise<void> {
    this.closing = true;
    const sockets = [...this.io.of('/').sockets.values()];
    const flushed = sockets.map(
      (socket) => new Promise<void>((resolve) => socket.conn.once('close', () => resolve())),
    );
    for (const socket of sockets) this.endSession(socket, DisconnectReason.SERVER_SHUTTING_DOWN);
    // Closing the server at once would drop the frames still being written.
    await Promise.race([
      Promise.all(flushed),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_SOCKET_DRAIN_MS)),
    ]);
    await new Promise<void>((resolve) => {
      void this.io.close(() => resolve());
    });
  }

  /** UC-RT-1 steps 2–4, in order: origin, IP limit, token, user limit, profile. */
  private async authenticate(socket: Socket): Promise<void> {
    if (this.closing) throw connectError(ConnectErrorCode.SERVICE_UNAVAILABLE);
    const { headers, address, auth } = socket.handshake;
    const origin = headers.origin;
    if (origin === undefined || !this.deps.env.CORS_ALLOWED_ORIGINS.includes(origin)) {
      throw connectError(ConnectErrorCode.ORIGIN_NOT_ALLOWED);
    }
    const ip = clientIp(headers, address, this.deps.env.TRUST_PROXY_HOPS);
    if (!(await this.deps.limiter.allow(ipKey(ip)))) throw connectError(ConnectErrorCode.RATE_LIMITED);

    const token = (auth as { token?: unknown }).token;
    if (typeof token !== 'string' || token.length === 0) throw connectError(ConnectErrorCode.UNAUTHENTICATED);
    const session = await this.deps.jwtVerifier.verifySession(token).catch(() => {
      throw connectError(ConnectErrorCode.UNAUTHENTICATED);
    });
    if (!(await this.deps.limiter.allow(userKey(session.userId)))) {
      throw connectError(ConnectErrorCode.RATE_LIMITED);
    }

    const rooms = await this.deps.profileRooms.roomsOf(session.userId, session.role);
    if (rooms === null) throw connectError(ConnectErrorCode.FORBIDDEN);
    const data: SessionData = {
      userId: session.userId,
      role: session.role,
      rooms,
      expiresAt: session.expiresAt,
    };
    socket.data = data;
  }

  private onConnection(socket: Socket): void {
    const session = socket.data as SessionData;
    void socket.join(session.rooms);

    // RT-2: the token's life is the socket's life; the client refreshes through REST and reconnects.
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, session.expiresAt.getTime() - this.deps.clock.now().getTime()),
    );
    const expiry = setTimeout(() => this.endSession(socket, DisconnectReason.TOKEN_EXPIRED), delay);
    socket.on('disconnect', () => clearTimeout(expiry));

    this.limitSignals(socket);
    socket.onAny((event: string) => {
      if (!KNOWN_SIGNALS.has(event)) this.deps.logger.debug('realtime signal ignored', { signal: event });
    });
    this.deps.logger.debug('realtime socket connected', { userId: session.userId, role: session.role });
  }

  /** RT-5: at most N signals per second per socket; over it, an ack answers RATE_LIMITED. */
  private limitSignals(socket: Socket): void {
    let windowStartedAt = 0;
    let count = 0;
    socket.use((packet, next) => {
      const now = this.deps.clock.now().getTime();
      if (now - windowStartedAt >= SIGNAL_WINDOW_MS) {
        windowStartedAt = now;
        count = 0;
      }
      count += 1;
      if (count <= this.deps.env.REALTIME_SIGNAL_RATE_PER_SECOND) {
        next();
        return;
      }
      const ack: unknown = packet[packet.length - 1];
      if (typeof ack === 'function')
        (ack as (reply: object) => void)({ ok: false, code: AckErrorCode.RATE_LIMITED });
    });
  }

  /** `session.ended` with the reason, then the disconnect (RT-8). */
  private endSession(socket: Socket, reason: DisconnectReason): void {
    const message: RealtimeMessage<typeof RealtimeMessageType.SESSION_ENDED> = {
      type: RealtimeMessageType.SESSION_ENDED,
      eventId: randomUUID(),
      occurredAt: this.deps.clock.now().toISOString(),
      data: { reason },
    };
    socket.emit(message.type, message);
    socket.disconnect(true);
  }

  /** Known refusals keep their code; anything else (a lookup failed) is logged and answered generically. */
  private asConnectError(error: unknown): ConnectError {
    if (error instanceof ConnectError) return error;
    this.deps.logger.error('realtime handshake failed', { error });
    return connectError(ConnectErrorCode.INTERNAL_ERROR);
  }
}
