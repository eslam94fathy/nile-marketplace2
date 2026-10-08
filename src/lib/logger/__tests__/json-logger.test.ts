import { describe, expect, it } from 'vitest';
import { runWithContext } from '../../context';
import { type ILogWriter, JsonLogger, type LogLevelKey, maskEmail, maskPhone } from '..';

class MemoryWriter implements ILogWriter {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
  get parsed(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

const fixedClock = { now: () => new Date('2026-10-08T12:00:00.000Z') };

function makeLogger(level: LogLevelKey = 'debug') {
  const writer = new MemoryWriter();
  const logger = new JsonLogger({ level, service: 'nile-api', env: 'test', writer, clock: fixedClock });
  return { logger, writer };
}

describe('lib/logger JsonLogger', () => {
  it('writes one JSON line with the envelope fields and ISO timestamp', () => {
    const { logger, writer } = makeLogger();
    logger.info('order placed', { orderId: 'o-1', durationMs: 12 });
    expect(writer.lines).toHaveLength(1);
    expect(writer.parsed[0]).toEqual({
      level: 'info',
      timestamp: '2026-10-08T12:00:00.000Z',
      message: 'order placed',
      service: 'nile-api',
      env: 'test',
      orderId: 'o-1',
      durationMs: 12,
    });
  });

  it('filters by level', () => {
    const { logger, writer } = makeLogger('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');
    expect(writer.parsed.map((line) => line.level)).toEqual(['warn', 'error', 'fatal']);
  });

  it('adds correlationId and userId from the execution context', () => {
    const { logger, writer } = makeLogger();
    runWithContext({ correlationId: 'c-1', userId: 'u-1' }, () => logger.info('inside'));
    logger.info('outside');
    expect(writer.parsed[0]).toMatchObject({ correlationId: 'c-1', userId: 'u-1' });
    expect(writer.parsed[1]).not.toHaveProperty('correlationId');
  });

  it('child loggers carry their bindings', () => {
    const { logger, writer } = makeLogger();
    logger.child({ module: 'catalog' }).child({ job: 'reindex' }).info('x');
    expect(writer.parsed[0]).toMatchObject({ module: 'catalog', job: 'reindex' });
  });

  it('redacts secrets and masks PII at any depth', () => {
    const { logger, writer } = makeLogger();
    logger.info('login', {
      email: 'someone@example.com',
      password: 'p@ss',
      nested: { refreshToken: 'abc', recipientPhone: '+201012345678', items: [{ otp: '123456' }] },
      Authorization: 'Bearer x',
      body: { anything: true },
    });
    const line = writer.lines[0] ?? '';
    for (const secret of ['p@ss', 'abc', '123456', 'Bearer x', 'someone@', '12345678']) {
      expect(line).not.toContain(secret);
    }
    expect(writer.parsed[0]).toMatchObject({
      email: 's***@example.com',
      password: '[REDACTED]',
      nested: { refreshToken: '[REDACTED]', recipientPhone: '+201*******78', items: [{ otp: '[REDACTED]' }] },
      Authorization: '[REDACTED]',
      body: '[REDACTED]',
    });
  });

  it('serialises errors with name, message, code, stack and cause', () => {
    const { logger, writer } = makeLogger();
    const cause = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    logger.error('db failed', { error: new TypeError('boom', { cause }) });
    const error = writer.parsed[0]?.error as Record<string, unknown>;
    expect(error.name).toBe('TypeError');
    expect(error.message).toBe('boom');
    expect(typeof error.stack).toBe('string');
    expect(error.cause).toMatchObject({ name: 'Error', message: 'connection reset', code: 'ECONNRESET' });
  });

  it('survives circular references, BigInt, symbols, functions and odd numbers', () => {
    const { logger, writer } = makeLogger();
    const circular: Record<string, unknown> = { name: 'a' };
    circular.self = circular;
    logger.info('odd', {
      circular,
      big: 10n,
      sym: Symbol('s'),
      fn: () => 1,
      nan: Number.NaN,
      when: new Date(0),
    });
    expect(writer.parsed[0]).toMatchObject({
      circular: { name: 'a', self: '[Circular]' },
      big: '10',
      sym: 'Symbol(s)',
      fn: '[Function]',
      nan: 'NaN',
      when: '1970-01-01T00:00:00.000Z',
    });
  });

  it('does not let fields overwrite envelope keys', () => {
    const { logger, writer } = makeLogger();
    logger.info('real message', { level: 'fake', message: 'fake' });
    expect(writer.parsed[0]).toMatchObject({
      level: 'info',
      message: 'real message',
      fields: { level: 'fake', message: 'fake' },
    });
  });

  it('masks emails and phones', () => {
    expect(maskEmail('ab@x.io')).toBe('a***@x.io');
    expect(maskEmail('not-an-email')).toBe('[REDACTED]');
    expect(maskPhone('+201012345678')).toBe('+201*******78');
  });
});
