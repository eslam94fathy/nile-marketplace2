import { type IClock } from '../clock';
import { getContext } from '../context';
import { type DbTransaction } from '../db';
import { type EventContract } from './contracts';

export const OUTBOX_TABLE = 'events_outbox';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OutboxEvent<TPayload extends object> {
  contract: EventContract<TPayload>;
  aggregateId: string;
  payload: TPayload;
}

/** Writes domain events in the caller's transaction, so the state change and its events commit together. */
export interface IOutbox {
  add<TPayload extends object>(trx: DbTransaction, event: OutboxEvent<TPayload>): Promise<void>;
  addMany(trx: DbTransaction, events: readonly OutboxEvent<object>[]): Promise<void>;
}

export class Outbox implements IOutbox {
  constructor(private readonly clock: IClock) {}

  add<TPayload extends object>(trx: DbTransaction, event: OutboxEvent<TPayload>): Promise<void> {
    return this.addMany(trx, [event]);
  }

  async addMany(trx: DbTransaction, events: readonly OutboxEvent<object>[]): Promise<void> {
    if (events.length === 0) return;
    const now = this.clock.now();
    // Carry the request's correlation id so consumers continue the trace (G26).
    const correlationId = getContext()?.correlationId;
    const rows = events.map((event) => ({
      aggregate_type: event.contract.aggregateType,
      aggregate_id: event.aggregateId,
      event_type: event.contract.type,
      event_version: event.contract.version,
      payload: JSON.stringify(event.payload),
      correlation_id: correlationId && UUID_PATTERN.test(correlationId) ? correlationId : null,
      attempts: 0,
      next_attempt_at: now,
    }));
    // One multi-row insert (CLAUDE.md §6.4).
    await trx(OUTBOX_TABLE).insert(rows);
  }
}
