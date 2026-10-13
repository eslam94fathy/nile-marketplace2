/**
 * An event contract: name (= routing key), payload schema version, aggregate type and the payload type.
 * Contracts live in the shared kernel so a consumer never imports the publishing module
 * (docs/design/01-architecture.md §2, docs/spec/02-events.md).
 */
export interface EventContract<TPayload extends object> {
  readonly type: string;
  readonly version: number;
  readonly aggregateType: string;
  /** Phantom field: carries the payload type, never set at runtime. */
  readonly __payload?: TPayload;
}

export type PayloadOf<C> = C extends EventContract<infer P> ? P : never;

export function defineEvent<TPayload extends object>(
  type: string,
  version: number,
  aggregateType: string,
): EventContract<TPayload> {
  return Object.freeze({ type, version, aggregateType });
}

/** Wire format of every message (docs/spec/02-events.md §1). */
export interface EventEnvelope<TPayload extends object = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  version: number;
  occurredAt: string;
  correlationId: string | null;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
}
