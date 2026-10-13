import amqp, { type AmqpConnectionManager, type ChannelWrapper } from 'amqp-connection-manager';
import { type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import {
  type ConsumeResult,
  type ConsumerSpec,
  type DeadLetterInfo,
  type IMessageBroker,
  type PublishOptions,
  type ReceivedMessage,
} from './message-broker.interface';

const ATTEMPT_HEADER = 'x-attempt';
const DEFAULT_EXCHANGE = '';

export interface RabbitMqBrokerOptions {
  url: string;
  heartbeatSeconds: number;
  publishTimeoutMs: number;
}

/** Retry queue names carry their delay, so changing the config never conflicts with an existing queue. */
export const retryQueueName = (queue: string, delayMs: number) => `${queue}.retry.${delayMs}ms`;
export const deadLetterQueueName = (queue: string) => `${queue}.dlq`;

/**
 * RabbitMQ adapter (amqp-connection-manager: reconnects and re-runs channel setup automatically).
 * Retry topology per consumer queue Q:
 *   Q ← exchange bindings
 *   Q.retry.<d>ms (x-message-ttl = d, dead-letters back to Q)   one per delay
 *   Q.dlq
 */
export class RabbitMqBroker implements IMessageBroker {
  private manager: AmqpConnectionManager | undefined;
  private publisher: ChannelWrapper | undefined;
  private readonly consumers: ChannelWrapper[] = [];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: RabbitMqBrokerOptions) {}

  async connect(timeoutMs: number): Promise<void> {
    if (this.manager) return;
    this.manager = amqp.connect([this.options.url], {
      heartbeatIntervalInSeconds: this.options.heartbeatSeconds,
    });
    // Without an 'error' listener a failed reconnect would be an unhandled 'error' event.
    this.manager.on('connectFailed', () => undefined);
    this.publisher = this.manager.createChannel({
      confirm: true,
      json: false,
      publishTimeout: this.options.publishTimeoutMs,
    });
    await this.manager.connect({ timeout: timeoutMs });
    // Resolve only once the publisher channel is open too: closing a half-opened channel makes
    // amqplib reject an internal reply nobody awaits (an unhandled rejection at shutdown).
    await this.publisher.waitForConnect();
  }

  isConnected(): boolean {
    return this.manager?.isConnected() ?? false;
  }

  async assertExchange(exchange: string): Promise<void> {
    await this.requirePublisher().addSetup(async (channel: ConfirmChannel) => {
      await channel.assertExchange(exchange, 'topic', { durable: true });
    });
  }

  async publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: PublishOptions,
  ): Promise<void> {
    await this.requirePublisher().publish(exchange, routingKey, content, {
      persistent: true,
      messageId: options.messageId,
      contentType: options.contentType,
      timestamp: options.timestamp,
      correlationId: options.correlationId,
      headers: options.headers,
    });
  }

  async consume(
    spec: ConsumerSpec,
    handler: (message: ReceivedMessage) => Promise<ConsumeResult>,
    onDeadLetter: (info: DeadLetterInfo) => void,
  ): Promise<void> {
    const manager = this.requireManager();
    const channel = manager.createChannel({
      confirm: true,
      json: false,
      publishTimeout: this.options.publishTimeoutMs,
      setup: async (raw: ConfirmChannel) => {
        await raw.prefetch(spec.prefetch);
        await raw.assertExchange(spec.exchange, 'topic', { durable: true });
        await raw.assertQueue(spec.queue, { durable: true });
        for (const key of spec.bindingKeys) await raw.bindQueue(spec.queue, spec.exchange, key);
        for (const delayMs of spec.retryDelaysMs) {
          await raw.assertQueue(retryQueueName(spec.queue, delayMs), {
            durable: true,
            arguments: {
              'x-message-ttl': delayMs,
              'x-dead-letter-exchange': DEFAULT_EXCHANGE,
              'x-dead-letter-routing-key': spec.queue,
            },
          });
        }
        await raw.assertQueue(deadLetterQueueName(spec.queue), { durable: true });
      },
    });
    this.consumers.push(channel);
    await channel.waitForConnect();

    await channel.consume(
      spec.queue,
      (raw: ConsumeMessage) => {
        const work = this.handle(channel, spec, raw, handler, onDeadLetter);
        this.inFlight.add(work);
        void work.finally(() => this.inFlight.delete(work));
      },
      { noAck: false },
    );
  }

  async close(): Promise<void> {
    for (const channel of this.consumers) await channel.cancelAll();
    await Promise.allSettled([...this.inFlight]);
    for (const channel of this.consumers) await channel.close();
    await this.publisher?.close();
    await this.manager?.close();
    this.manager = undefined;
    this.publisher = undefined;
    this.consumers.length = 0;
  }

  private async handle(
    channel: ChannelWrapper,
    spec: ConsumerSpec,
    raw: ConsumeMessage,
    handler: (message: ReceivedMessage) => Promise<ConsumeResult>,
    onDeadLetter: (info: DeadLetterInfo) => void,
  ): Promise<void> {
    const headers = (raw.properties.headers ?? {}) as Record<string, unknown>;
    const attemptHeader = headers[ATTEMPT_HEADER];
    const attempt = typeof attemptHeader === 'number' && Number.isInteger(attemptHeader) ? attemptHeader : 0;
    const message: ReceivedMessage = {
      content: raw.content,
      messageId: raw.properties.messageId as string | undefined,
      routingKey: raw.fields.routingKey,
      correlationId: raw.properties.correlationId as string | undefined,
      attempt,
    };

    let result: ConsumeResult;
    try {
      result = await handler(message);
    } catch {
      result = 'retry';
    }

    try {
      if (result === 'ack') {
        channel.ack(raw);
        return;
      }
      const delayMs = result === 'retry' ? spec.retryDelaysMs[attempt] : undefined;
      const target =
        delayMs === undefined ? deadLetterQueueName(spec.queue) : retryQueueName(spec.queue, delayMs);
      // Re-publish (confirmed) before acking, so a crash in between can only duplicate, never lose.
      await channel.sendToQueue(target, raw.content, {
        persistent: true,
        messageId: message.messageId,
        contentType: raw.properties.contentType as string | undefined,
        correlationId: message.correlationId,
        headers: { ...headers, [ATTEMPT_HEADER]: attempt + 1, 'x-original-routing-key': message.routingKey },
      });
      channel.ack(raw);
      if (delayMs === undefined) {
        onDeadLetter({
          queue: spec.queue,
          messageId: message.messageId,
          routingKey: message.routingKey,
          attempt,
          reason: result === 'dead-letter' ? 'handler_requested' : 'retries_exhausted',
        });
      }
    } catch {
      // Could not re-publish: give the message back to the broker for redelivery.
      channel.nack(raw, false, true);
    }
  }

  private requireManager(): AmqpConnectionManager {
    if (!this.manager) throw new Error('RabbitMqBroker.connect() must be called first');
    return this.manager;
  }

  private requirePublisher(): ChannelWrapper {
    if (!this.publisher) throw new Error('RabbitMqBroker.connect() must be called first');
    return this.publisher;
  }
}
