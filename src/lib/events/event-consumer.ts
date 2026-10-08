import { randomUUID } from 'node:crypto';
import { type ConsumeResult, type IMessageBroker, type ReceivedMessage } from '../../pkg/messaging';
import { type Env } from '../config';
import { runWithContext } from '../context';
import { type DbTransaction, type ITransactionRunner } from '../db';
import { type ILogger } from '../logger';
import { type EventContract, type EventEnvelope } from './contracts';

export const PROCESSED_EVENTS_TABLE = 'processed_events';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throw from a handler when retrying can never succeed: the message goes straight to the DLQ. */
export class PermanentEventError extends Error {
  override readonly name = 'PermanentEventError';
}

export interface EventHandlerDefinition {
  /** Queue name = consumer name, `<module>.<purpose>` (docs/spec/02-events.md §2). */
  name: string;
  events: readonly EventContract<object>[];
  /**
   * Runs inside the same transaction as the `processed_events` insert (architecture §3.2):
   * effects + dedupe commit together. Must be state-machine guarded (stale events are a no-op).
   */
  handle(envelope: EventEnvelope, trx: DbTransaction): Promise<void>;
}

type ConsumerEnv = Pick<Env, 'RABBITMQ_EXCHANGE' | 'RABBITMQ_PREFETCH' | 'MQ_RETRY_DELAYS_MS'>;

function parseEnvelope(content: Buffer): EventEnvelope | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  const valid =
    typeof e.eventId === 'string' &&
    UUID_PATTERN.test(e.eventId) &&
    typeof e.eventType === 'string' &&
    typeof e.version === 'number' &&
    typeof e.occurredAt === 'string' &&
    (e.correlationId === null || typeof e.correlationId === 'string') &&
    typeof e.aggregateType === 'string' &&
    typeof e.aggregateId === 'string' &&
    typeof e.payload === 'object' &&
    e.payload !== null;
  return valid ? (raw as EventEnvelope) : undefined;
}

/**
 * Wires an event handler to its queue: envelope validation, correlation restore,
 * idempotency on eventId, retry/DLQ decisions (architecture §5, CLAUDE.md §10).
 */
export class EventConsumerHost {
  constructor(
    private readonly broker: IMessageBroker,
    private readonly transactions: ITransactionRunner,
    private readonly logger: ILogger,
    private readonly env: ConsumerEnv,
  ) {}

  async start(definition: EventHandlerDefinition): Promise<void> {
    const supported = new Map(definition.events.map((contract) => [contract.type, contract.version]));
    const logger = this.logger.child({ consumer: definition.name });

    await this.broker.consume(
      {
        queue: definition.name,
        exchange: this.env.RABBITMQ_EXCHANGE,
        bindingKeys: [...supported.keys()],
        retryDelaysMs: this.env.MQ_RETRY_DELAYS_MS,
        prefetch: this.env.RABBITMQ_PREFETCH,
      },
      (message) => this.handle(definition, supported, logger, message),
      (info) => logger.error('message dead-lettered', { event: 'MQ_DEAD_LETTERED', ...info }),
    );
    logger.info('consumer started', { events: [...supported.keys()] });
  }

  private async handle(
    definition: EventHandlerDefinition,
    supported: ReadonlyMap<string, number>,
    logger: ILogger,
    message: ReceivedMessage,
  ): Promise<ConsumeResult> {
    const envelope = parseEnvelope(message.content);
    if (!envelope || supported.get(envelope.eventType) !== envelope.version) {
      logger.error('unprocessable message', {
        messageId: message.messageId,
        routingKey: message.routingKey,
        reason: envelope ? 'unsupported event type or version' : 'malformed envelope',
      });
      return 'dead-letter';
    }

    const correlationId = envelope.correlationId ?? randomUUID();
    return runWithContext({ correlationId }, async () => {
      const fields = { eventId: envelope.eventId, eventType: envelope.eventType, attempt: message.attempt };
      try {
        const processed = await this.transactions.run(async (trx) => {
          const inserted = await trx(PROCESSED_EVENTS_TABLE)
            .insert({ consumer: definition.name, event_id: envelope.eventId })
            .onConflict(['consumer', 'event_id'])
            .ignore()
            .returning<{ event_id: string }[]>('event_id');
          if (inserted.length === 0) return false;
          await definition.handle(envelope, trx);
          return true;
        });
        if (processed) logger.info('event processed', fields);
        else logger.debug('duplicate event skipped', fields);
        return 'ack';
      } catch (error) {
        if (error instanceof PermanentEventError) {
          logger.error('event handler failed permanently', { ...fields, error });
          return 'dead-letter';
        }
        logger.warn('event handler failed, will retry', { ...fields, error });
        return 'retry';
      }
    });
  }
}
