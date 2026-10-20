import { randomUUID } from 'node:crypto';
import { Emitter } from '@socket.io/redis-emitter';
import { type Redis } from 'ioredis';
import { type IClock } from '../clock';
import { type ILogger } from '../logger';
import { type DisconnectReason, type RealtimeMessage, RealtimeMessageType, RealtimeRoom } from './messages';

/**
 * The Socket.IO adapter / emitter channel prefix. Derived from REDIS_KEY_PREFIX so environments (and
 * test files) sharing a Redis never see each other's sockets; the gateway and the worker must agree.
 */
export const realtimeChannelKey = (redisKeyPrefix: string): string => `${redisKeyPrefix}socket.io`;

/**
 * Emits to sockets from outside the gateway (spec 15 §2), after a commit and never inside a DB
 * transaction. Best effort: when Redis is down the message is dropped with a warn (RT-3); the data is
 * in the database and clients refetch.
 */
export interface IRealtimeEmitter {
  toRooms(rooms: readonly string[], message: RealtimeMessage): void;
  /** `session.ended` then a disconnect of every socket of the user, on every gateway (UC-RT-3). */
  disconnectUser(userId: string, reason: DisconnectReason): void;
}

export class RedisRealtimeEmitter implements IRealtimeEmitter {
  private readonly emitter: Emitter;

  constructor(
    redis: Redis,
    redisKeyPrefix: string,
    private readonly clock: IClock,
    private readonly logger: ILogger,
  ) {
    // The emitter calls `publish` and drops the promise (5.1.0, plan §2.3): a rejection would be
    // unhandled and stop the worker. `publish` is the only method it uses.
    const client = {
      publish: (channel: string, message: string | Buffer) =>
        redis.publish(channel, message).catch((error: unknown) => {
          this.logger.warn('realtime emit failed, message dropped', { event: 'REALTIME_EMIT_FAILED', error });
          return 0;
        }),
    };
    this.emitter = new Emitter(client, { key: realtimeChannelKey(redisKeyPrefix) });
  }

  toRooms(rooms: readonly string[], message: RealtimeMessage): void {
    if (rooms.length === 0) return;
    this.emitter.to([...rooms]).emit(message.type, message);
  }

  disconnectUser(userId: string, reason: DisconnectReason): void {
    const room = RealtimeRoom.user(userId);
    const ended: RealtimeMessage<typeof RealtimeMessageType.SESSION_ENDED> = {
      type: RealtimeMessageType.SESSION_ENDED,
      eventId: randomUUID(),
      occurredAt: this.clock.now().toISOString(),
      data: { reason },
    };
    // Two channels, so the order isn't guaranteed: a client that misses the reason still can't
    // reconnect (the deny entry refuses the handshake).
    this.emitter.to(room).emit(ended.type, ended);
    this.emitter.in(room).disconnectSockets(true);
  }
}
