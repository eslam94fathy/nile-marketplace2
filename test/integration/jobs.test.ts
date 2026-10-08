import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInfrastructure, closeInfrastructure } from '../../src/infrastructure';
import { OUTBOX_TABLE, PROCESSED_EVENTS_TABLE } from '../../src/lib/events';
import { createCleanupJobs, JobRunner } from '../../src/lib/jobs';
import { createMemoryLogger } from '../helpers/memory-logger';
import { startTestInfra, type TestInfra } from '../helpers/test-infra';

const DAY_MS = 86_400_000;

describe('scheduled jobs (architecture §6)', () => {
  let t: TestInfra;

  beforeAll(async () => {
    t = await startTestInfra();
  });
  afterAll(async () => {
    await t.close();
  });

  it('pg_try_advisory_lock: with two workers, a job runs on only one at a time', async () => {
    const otherWorker = await createInfrastructure(t.infra.env, createMemoryLogger().logger);
    try {
      let executions = 0;
      const job = {
        name: `test-job-${randomUUID()}`,
        intervalMs: 60_000,
        run: async () => {
          executions += 1;
          await new Promise((resolve) => setTimeout(resolve, 300));
          return 1;
        },
      };
      const a = new JobRunner(t.infra.db.knex, t.infra.clock, t.infra.logger);
      const b = new JobRunner(otherWorker.db.knex, otherWorker.clock, otherWorker.logger);
      a.register(job);
      b.register(job);

      const results = await Promise.all([a.runOnce(job.name), b.runOnce(job.name)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(executions).toBe(1);

      // The lock is released afterwards: the next run goes through.
      expect(await b.runOnce(job.name)).toBe(true);
      expect(executions).toBe(2);
    } finally {
      await closeInfrastructure(otherWorker);
    }
  });

  it('a failing job is logged as JOB_FAILED and does not break the runner', async () => {
    const runner = new JobRunner(t.infra.db.knex, t.infra.clock, t.infra.logger);
    runner.register({
      name: 'test-failing-job',
      intervalMs: 60_000,
      run: () => Promise.reject(new Error('boom')),
    });
    expect(await runner.runOnce('test-failing-job')).toBe(true);
    expect(t.logs.entries().some((e) => e.event === 'JOB_FAILED' && e.job === 'test-failing-job')).toBe(true);
  });

  it('cleanup jobs delete only dispatched outbox rows and processed events past retention', async () => {
    const knex = t.infra.db.knex;
    const now = Date.now();
    const old = new Date(now - 40 * DAY_MS);
    const recent = new Date(now - DAY_MS);
    const outboxRow = (dispatchedAt: Date | null) => ({
      aggregate_type: 'seller',
      aggregate_id: randomUUID(),
      event_type: 'seller.approved',
      event_version: 1,
      payload: JSON.stringify({}),
      attempts: 0,
      next_attempt_at: old,
      dispatched_at: dispatchedAt,
    });
    await knex(OUTBOX_TABLE).insert([outboxRow(old), outboxRow(recent), outboxRow(null)]);
    await knex(PROCESSED_EVENTS_TABLE).insert([
      { consumer: 'c', event_id: randomUUID(), processed_at: old },
      { consumer: 'c', event_id: randomUUID(), processed_at: recent },
    ]);

    const runner = new JobRunner(knex, t.infra.clock, t.infra.logger);
    for (const job of createCleanupJobs(knex, t.infra.clock, t.infra.env)) runner.register(job);
    await runner.runOnce('outbox-cleanup');
    await runner.runOnce('processed-events-cleanup');

    const remainingOutbox = await knex(OUTBOX_TABLE).select('dispatched_at');
    expect(remainingOutbox).toHaveLength(2); // recent dispatched + undispatched
    expect(await knex(PROCESSED_EVENTS_TABLE).count<{ count: string }[]>('* as count')).toEqual([
      { count: '1' },
    ]);
  });
});
