import { type Knex } from 'knex';
import { toMs, TimeUnit } from '../../pkg/time';
import { type IClock } from '../clock';
import { type Env } from '../config';
import { PROCESSED_EVENTS_TABLE } from '../events/event-consumer';
import { OUTBOX_TABLE } from '../events/outbox';
import { type JobDefinition } from './job-runner';

/** Deletes in batches so one run never holds a long lock or a huge transaction. */
const DELETE_BATCH_SIZE = 5_000;

async function deleteInBatches(knex: Knex, sql: string, bindings: readonly Knex.Value[]): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await knex.raw<{ rowCount: number }>(sql, [...bindings, DELETE_BATCH_SIZE]);
    total += result.rowCount;
    if (result.rowCount < DELETE_BATCH_SIZE) return total;
  }
}

type CleanupEnv = Pick<
  Env,
  'OUTBOX_RETENTION_DAYS' | 'PROCESSED_EVENTS_RETENTION_DAYS' | 'CLEANUP_JOB_INTERVAL_MS'
>;

/** Retention jobs (architecture §6, DB-Q5). */
export function createCleanupJobs(knex: Knex, clock: IClock, env: CleanupEnv): JobDefinition[] {
  const olderThan = (days: number) => new Date(clock.now().getTime() - toMs(days, TimeUnit.DAY));
  return [
    {
      name: 'outbox-cleanup',
      intervalMs: env.CLEANUP_JOB_INTERVAL_MS,
      run: () =>
        deleteInBatches(
          knex,
          `DELETE FROM ${OUTBOX_TABLE} WHERE id IN (
             SELECT id FROM ${OUTBOX_TABLE} WHERE dispatched_at IS NOT NULL AND dispatched_at < ? LIMIT ?)`,
          [olderThan(env.OUTBOX_RETENTION_DAYS)],
        ),
    },
    {
      name: 'processed-events-cleanup',
      intervalMs: env.CLEANUP_JOB_INTERVAL_MS,
      run: () =>
        deleteInBatches(
          knex,
          `DELETE FROM ${PROCESSED_EVENTS_TABLE} WHERE (consumer, event_id) IN (
             SELECT consumer, event_id FROM ${PROCESSED_EVENTS_TABLE} WHERE processed_at < ? LIMIT ?)`,
          [olderThan(env.PROCESSED_EVENTS_RETENTION_DAYS)],
        ),
    },
  ];
}
