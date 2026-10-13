import { type Knex } from 'knex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRunner } from '../job-runner';

const logger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
});
const clock = { now: () => new Date() };

/** A knex whose pool can't hand out a connection (pool exhausted, database unreachable). */
function knexWithoutConnections(): Knex {
  const error = new Error('Knex: Timeout acquiring a connection. The pool is probably full.');
  return {
    client: {
      acquireConnection: vi.fn(() => Promise.reject(error)),
      releaseConnection: vi.fn(() => Promise.resolve()),
    },
  } as unknown as Knex;
}

/*
 * Regression (P8 load baseline): a failed connection acquisition rejected outside execute()'s error
 * handling; the scheduler had no catch, so it became an unhandled rejection and stopped the worker.
 */
describe('lib/jobs JobRunner without a database connection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runOnce skips the run, logs JOB_FAILED and never calls the job', async () => {
    const log = logger();
    const run = vi.fn(() => Promise.resolve(0));
    const runner = new JobRunner(knexWithoutConnections(), clock, log);
    runner.register({ name: 'test-job', intervalMs: 1000, run });

    await expect(runner.runOnce('test-job')).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'job skipped: no database connection',
      expect.objectContaining({ event: 'JOB_FAILED', job: 'test-job' }),
    );
  });

  it('the scheduler keeps going: no unhandled rejection, the next interval tries again', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const knex = knexWithoutConnections();
      const runner = new JobRunner(knex, clock, logger());
      runner.register({ name: 'test-job', intervalMs: 1000, run: () => Promise.resolve(0) });
      runner.start();
      await vi.advanceTimersByTimeAsync(2_500);
      await runner.stop();
      // Started at 0, then every 1000 ms: three attempts, all survived.
      expect(
        vi.mocked(knex.client as { acquireConnection: () => Promise<unknown> }).acquireConnection,
      ).toHaveBeenCalledTimes(3);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
