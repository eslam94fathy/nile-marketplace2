import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { runWithContext } from '../../context';
import { HTTP_STATUS } from '../../http/status-codes';
import { type ILogger, type LogFields } from '../../logger';
import { AppError, createErrorHandler, PgErrorMapper, rateLimited } from '..';
import { errorBody } from '../../../../test/helpers/http';

class SpyLogger implements ILogger {
  readonly entries: { level: string; message: string; fields?: LogFields }[] = [];
  fatal = (message: string, fields?: LogFields) => this.entries.push({ level: 'fatal', message, fields });
  error = (message: string, fields?: LogFields) => this.entries.push({ level: 'error', message, fields });
  warn = (message: string, fields?: LogFields) => this.entries.push({ level: 'warn', message, fields });
  info = (message: string, fields?: LogFields) => this.entries.push({ level: 'info', message, fields });
  debug = (message: string, fields?: LogFields) => this.entries.push({ level: 'debug', message, fields });
  child = () => this;
}

function buildApp(throwing: () => unknown, mapper = new PgErrorMapper()) {
  const logger = new SpyLogger();
  const app = express();
  app.use((_req, _res, next) => runWithContext({ correlationId: 'corr-1' }, next));
  app.use(express.json({ limit: '1kb' }));
  app.post('/boom', () => {
    throw throwing();
  });
  app.use(createErrorHandler(logger, mapper));
  return { app, logger };
}

describe('lib/error global error handler', () => {
  it('maps AppError to the envelope with correlationId', async () => {
    const { app } = buildApp(
      () =>
        new AppError('PRODUCT_NOT_FOUND', 'Product not found', HTTP_STATUS.NOT_FOUND, {
          details: [{ field: 'id', constraint: 'exists', message: 'no such product' }],
        }),
    );
    const res = await request(app).post('/boom');
    expect(res.status).toBe(404);
    expect(errorBody(res)).toEqual({
      success: false,
      error: {
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
        details: [{ field: 'id', constraint: 'exists', message: 'no such product' }],
      },
      correlationId: 'corr-1',
    });
  });

  it('hides unknown errors behind a generic 500 and logs them with the stack', async () => {
    const { app, logger } = buildApp(() => new Error('SELECT secret FROM users failed'));
    const res = await request(app).post('/boom');
    expect(res.status).toBe(500);
    expect(errorBody(res).error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
    expect(JSON.stringify(errorBody(res))).not.toContain('secret');
    const entry = logger.entries.find((e) => e.level === 'error');
    expect(entry?.fields).toMatchObject({ method: 'POST', statusCode: 500, errorCode: 'INTERNAL_ERROR' });
    expect((entry?.fields?.error as Error).message).toContain('SELECT secret');
  });

  it('maps malformed JSON and oversized bodies', async () => {
    const { app } = buildApp(() => new Error('unreachable'));
    const bad = await request(app).post('/boom').set('Content-Type', 'application/json').send('{"a":');
    expect(bad.status).toBe(400);
    expect(errorBody(bad).error.code).toBe('MALFORMED_JSON');
    const big = await request(app)
      .post('/boom')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ a: 'x'.repeat(2_000) }));
    expect(big.status).toBe(413);
    expect(errorBody(big).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('maps Postgres constraint errors: registered names first, then generic codes', async () => {
    const mapper = new PgErrorMapper();
    mapper.register(
      'uq_users_email',
      (cause) =>
        new AppError('EMAIL_ALREADY_REGISTERED', 'Email already registered', HTTP_STATUS.CONFLICT, { cause }),
    );
    const registered = buildApp(
      () => Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_users_email' }),
      mapper,
    );
    expect(errorBody(await request(registered.app).post('/boom')).error.code).toBe(
      'EMAIL_ALREADY_REGISTERED',
    );

    const cases: [string, number, string][] = [
      ['23505', 409, 'CONFLICT'],
      ['23503', 422, 'REFERENCE_NOT_FOUND'],
      ['23001', 409, 'CONFLICT'],
      ['23514', 422, 'CONSTRAINT_VIOLATION'],
    ];
    for (const [code, status, errorCode] of cases) {
      const { app } = buildApp(() => Object.assign(new Error('pg'), { code, constraint: 'other' }), mapper);
      const res = await request(app).post('/boom');
      expect([res.status, errorBody(res).error.code]).toEqual([status, errorCode]);
    }
  });

  it('logs selected 4xx (here 429) at warn, without a stack', async () => {
    const { app, logger } = buildApp(() => rateLimited());
    const res = await request(app).post('/boom');
    expect(res.status).toBe(429);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.level).toBe('warn');
    expect(logger.entries[0]?.fields).toMatchObject({ errorCode: 'RATE_LIMITED' });
    expect(logger.entries[0]?.fields).not.toHaveProperty('error');
  });

  it('refuses to register the same constraint twice', () => {
    const mapper = new PgErrorMapper();
    mapper.register('uq_x', () => rateLimited());
    expect(() => mapper.register('uq_x', () => rateLimited())).toThrow(/already registered/);
  });
});
