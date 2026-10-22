import { describe, expect, it, vi } from 'vitest';
import { type Redis } from 'ioredis';
import { type ILogger } from '../../../lib/logger';
import { RealtimeMessageType, RedisRealtimeEmitter } from '../../../lib/realtime';
import { clientIp } from '../gateway/client-ip';

describe('clientIp (the api trust-proxy rule)', () => {
  it('without proxies: the socket address, X-Forwarded-For ignored', () => {
    expect(clientIp({ 'x-forwarded-for': '6.6.6.6' }, '10.0.0.5', 0)).toBe('10.0.0.5');
  });

  it('behind one proxy (the ALB): the entry it appended; spoofed entries to the left are ignored', () => {
    expect(clientIp({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, '10.0.0.5', 1)).toBe('203.0.113.9');
  });

  it('more trusted hops than entries: the leftmost address', () => {
    expect(clientIp({}, '10.0.0.5', 1)).toBe('10.0.0.5');
    expect(clientIp({ 'x-forwarded-for': '203.0.113.9' }, '10.0.0.5', 5)).toBe('203.0.113.9');
  });
});

describe('RedisRealtimeEmitter', () => {
  it('a failed publish is a warn, never an unhandled rejection (RT-3, plan §2.3)', async () => {
    const publish = vi.fn(() => Promise.reject(new Error('Connection is closed.')));
    const warn = vi.fn();
    const logger = { warn } as unknown as ILogger;
    const emitter = new RedisRealtimeEmitter(
      { publish } as unknown as Redis,
      't:abc:',
      { now: () => new Date('2026-10-20T10:00:00Z') },
      logger,
    );
    emitter.toRooms(['user:1'], {
      type: RealtimeMessageType.MEDIA_UPDATED,
      eventId: 'e1',
      occurredAt: '2026-10-20T10:00:00Z',
      data: { mediaId: 'm1', status: 'ready' },
    });
    emitter.disconnectUser('u1', 'account_suspended');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(3));
    // Channels carry the environment's key prefix, so environments sharing a Redis stay apart.
    const channels = publish.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(channels.every((channel) => channel.startsWith('t:abc:socket.io'))).toBe(true);
  });

  it('no rooms, no publish', () => {
    const publish = vi.fn(() => Promise.resolve(1));
    const emitter = new RedisRealtimeEmitter(
      { publish } as unknown as Redis,
      'p:',
      { now: () => new Date() },
      { warn: vi.fn() } as unknown as ILogger,
    );
    emitter.toRooms([], {
      type: RealtimeMessageType.MEDIA_UPDATED,
      eventId: 'e1',
      occurredAt: 'x',
      data: { mediaId: 'm1', status: 'ready' },
    });
    expect(publish).not.toHaveBeenCalled();
  });
});
