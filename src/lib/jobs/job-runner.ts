import { createHash, randomUUID } from 'node:crypto';
import { type Knex } from 'knex';
import { type IClock } from '../clock';
import { runWithContext } from '../context';
import { type ILogger } from '../logger';

export interface JobDefinition {
  /** Stable name: also the advisory-lock key, so never reuse a name for a different job. */
  name: string;
  intervalMs: number;
  /** Returns the number of rows affected (logged). */
  run(): Promise<number>;
}

/** First key of the two-int advisory lock: our namespace ("NILE"), so we never collide with other apps. */
const LOCK_NAMESPACE = 0x4e494c45 | 0;

/** Second key: a stable 32-bit hash of the job name. */
export function jobLockKey(name: string): number {
  return createHash('sha256').update(name).digest().readInt32BE(0);
}

interface PooledClient {
  acquireConnection(): Promise<unknown>;
  releaseConnection(connection: unknown): Promise<void>;
}

interface ScheduledJob {
  definition: JobDefinition;
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | undefined;
}

/**
 * Interval jobs guarded by `pg_try_advisory_lock` (architecture §6, P0-Q8): with N workers, a job
 * runs on at most one of them at a time. Runs never overlap; the next run is scheduled after the
 * current one ends. The lock is a session lock held on a dedicated pooled connection, so the job
 * itself can use short transactions of its own.
 */
export class JobRunner {
  private readonly jobs = new Map<string, ScheduledJob>();
  private stopped = false;

  constructor(
    private readonly knex: Knex,
    private readonly clock: IClock,
    private readonly logger: ILogger,
  ) {}

  register(definition: JobDefinition): void {
    if (this.jobs.has(definition.name)) throw new Error(`Job "${definition.name}" registered twice`);
    this.jobs.set(definition.name, { definition, timer: undefined, running: undefined });
  }

  start(): void {
    for (const job of this.jobs.values()) this.schedule(job, 0);
    this.logger.info('job runner started', { jobs: [...this.jobs.keys()] });
  }

  /** Runs one job now (used by tests and the scheduler). Returns false if another instance held the lock. */
  async runOnce(name: string): Promise<boolean> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown job "${name}"`);
    return this.execute(job.definition);
  }

  /** Stops scheduling and waits for running jobs to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const job of this.jobs.values()) clearTimeout(job.timer);
    await Promise.allSettled([...this.jobs.values()].flatMap((job) => (job.running ? [job.running] : [])));
  }

  private schedule(job: ScheduledJob, delayMs: number): void {
    if (this.stopped) return;
    job.timer = setTimeout(() => {
      job.running = this.execute(job.definition)
        .then(() => undefined)
        .finally(() => {
          job.running = undefined;
          this.schedule(job, job.definition.intervalMs);
        });
    }, delayMs);
  }

  private async execute(definition: JobDefinition): Promise<boolean> {
    const lockKey = jobLockKey(definition.name);
    const connection = await this.pool().acquireConnection();
    try {
      const lock = await this.knex
        .raw<{ rows: { locked: boolean }[] }>('SELECT pg_try_advisory_lock(?, ?) AS locked', [
          LOCK_NAMESPACE,
          lockKey,
        ])
        .connection(connection);
      if (!lock.rows[0]?.locked) return false;

      try {
        await runWithContext({ correlationId: randomUUID() }, async () => {
          const startedAt = this.clock.now().getTime();
          try {
            const affected = await definition.run();
            const fields = {
              job: definition.name,
              affected,
              durationMs: this.clock.now().getTime() - startedAt,
            };
            if (affected > 0) this.logger.info('job finished', fields);
            else this.logger.debug('job finished', fields);
          } catch (error) {
            this.logger.error('job failed', {
              event: 'JOB_FAILED',
              job: definition.name,
              durationMs: this.clock.now().getTime() - startedAt,
              error,
            });
          }
        });
      } finally {
        await this.knex
          .raw('SELECT pg_advisory_unlock(?, ?)', [LOCK_NAMESPACE, lockKey])
          .connection(connection);
      }
      return true;
    } catch (error) {
      this.logger.error('job lock failed', { event: 'JOB_FAILED', job: definition.name, error });
      return false;
    } finally {
      await this.pool().releaseConnection(connection);
    }
  }

  /** Knex types its client as `any`; we only need these two pool calls. */
  private pool(): PooledClient {
    return this.knex.client as PooledClient;
  }
}
