import { type Knex } from 'knex';
import { type IMessageBroker } from '../../pkg/messaging';
import { toMs, TimeUnit } from '../../pkg/time';
import { type IClock } from '../clock';
import { type ILogger } from '../logger';
import { type EventEnvelope } from './contracts';
import { OUTBOX_TABLE } from './outbox';

/** A claimed batch is invisible to other drainers for this long (crash → re-claimed after it). */
export const OUTBOX_CLAIM_LEASE_MS = toMs(60, TimeUnit.SECOND);
const BASE_BACKOFF_MS = toMs(1, TimeUnit.SECOND);
const MAX_ERROR_LENGTH = 2000;
/** From this attempt on, every failure is logged at error (earlier ones at warn). */
const ERROR_LOG_FROM_ATTEMPT = 5;

interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  created_at: Date;
  attempts: number;
}

export interface DrainOptions {
  exchange: string;
  batchSize: number;
  maxBackoffMs: number;
}

/** Exponential backoff: 1 s, 2 s, 4 s … capped. */
export function outboxBackoffMs(attempts: number, maxBackoffMs: number): number {
  return Math.min(maxBackoffMs, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

export function toEnvelope(row: OutboxRow): EventEnvelope {
  return {
    eventId: row.id,
    eventType: row.event_type,
    version: row.event_version,
    occurredAt: row.created_at.toISOString(),
    correlationId: row.correlation_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
  };
}

/**
 * Outbox → RabbitMQ (architecture §5). No network call happens inside a DB transaction (CLAUDE.md §6.4):
 *   1. claim: one short transaction takes a batch with FOR UPDATE SKIP LOCKED and pushes its
 *      next_attempt_at forward by a lease, then commits;
 *   2. publish each row with publisher confirms, outside any transaction;
 *   3. mark the published rows dispatched; failed rows get attempts+1 and a backoff.
 * A crash between 1 and 3 only delays the rows until the lease ends: at-least-once delivery.
 */
export class OutboxDrainer {
  constructor(
    private readonly knex: Knex,
    private readonly broker: IMessageBroker,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly options: DrainOptions,
  ) {}

  /** Returns the number of events published. */
  async drainOnce(): Promise<number> {
    const rows = await this.claim();
    if (rows.length === 0) return 0;

    const published: string[] = [];
    for (const row of rows) {
      const envelope = toEnvelope(row);
      try {
        await this.broker.publish(
          this.options.exchange,
          envelope.eventType,
          Buffer.from(JSON.stringify(envelope)),
          {
            messageId: envelope.eventId,
            contentType: 'application/json',
            timestamp: Math.floor(row.created_at.getTime() / 1000),
            correlationId: envelope.correlationId ?? undefined,
            headers: { 'x-event-version': envelope.version },
          },
        );
        published.push(row.id);
      } catch (error) {
        await this.recordFailure(row, error);
      }
    }

    if (published.length > 0) {
      await this.knex(OUTBOX_TABLE).whereIn('id', published).update({ dispatched_at: this.clock.now() });
    }
    return published.length;
  }

  private async claim(): Promise<OutboxRow[]> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + OUTBOX_CLAIM_LEASE_MS);
    const result = await this.knex.raw<{ rows: OutboxRow[] }>(
      `
      UPDATE ${OUTBOX_TABLE} AS o
         SET next_attempt_at = ?
       WHERE o.id IN (
             SELECT id FROM ${OUTBOX_TABLE}
              WHERE dispatched_at IS NULL AND next_attempt_at <= ?
              ORDER BY next_attempt_at, id
              LIMIT ?
              FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.aggregate_type, o.aggregate_id, o.event_type, o.event_version, o.payload,
                o.correlation_id, o.created_at, o.attempts`,
      [leaseUntil, now, this.options.batchSize],
    );
    // RETURNING order is not guaranteed: publish in id (= creation, UUID v7) order.
    return result.rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private async recordFailure(row: OutboxRow, error: unknown): Promise<void> {
    const attempts = row.attempts + 1;
    const nextAttemptAt = new Date(
      this.clock.now().getTime() + outboxBackoffMs(attempts, this.options.maxBackoffMs),
    );
    const message = error instanceof Error ? error.message : String(error);
    await this.knex(OUTBOX_TABLE)
      .where({ id: row.id })
      .update({ attempts, next_attempt_at: nextAttemptAt, last_error: message.slice(0, MAX_ERROR_LENGTH) });
    const fields = {
      event: 'OUTBOX_PUBLISH_FAILED',
      eventId: row.id,
      eventType: row.event_type,
      attempts,
      error,
    };
    if (attempts >= ERROR_LOG_FROM_ATTEMPT) this.logger.error('outbox publish failed', fields);
    else this.logger.warn('outbox publish failed', fields);
  }
}
