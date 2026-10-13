export interface PublishOptions {
  messageId: string;
  contentType: string;
  timestamp?: number;
  correlationId?: string;
  headers?: Readonly<Record<string, string | number | boolean>>;
}

export interface ReceivedMessage {
  content: Buffer;
  messageId: string | undefined;
  routingKey: string;
  correlationId: string | undefined;
  /** 0 on first delivery, then 1, 2, … after each retry. */
  attempt: number;
}

/**
 * What the handler wants done with a message:
 * - `ack`: done (also for skipped duplicates)
 * - `retry`: transient failure, retry after the next backoff delay (dead-lettered when delays run out)
 * - `dead-letter`: permanent failure, straight to `<queue>.dlq`
 * A thrown error counts as `retry`.
 */
export type ConsumeResult = 'ack' | 'retry' | 'dead-letter';

export interface ConsumerSpec {
  queue: string;
  exchange: string;
  bindingKeys: readonly string[];
  /** One retry queue per delay; after the last one the message goes to `<queue>.dlq`. */
  retryDelaysMs: readonly number[];
  prefetch: number;
}

export interface DeadLetterInfo {
  queue: string;
  messageId: string | undefined;
  routingKey: string;
  attempt: number;
  reason: 'retries_exhausted' | 'handler_requested';
}

export interface IMessageBroker {
  connect(timeoutMs: number): Promise<void>;
  isConnected(): boolean;
  /** Declares a durable topic exchange (idempotent, re-applied on reconnect). */
  assertExchange(exchange: string): Promise<void>;
  /** Persistent publish, resolved only after the broker confirms it. */
  publish(exchange: string, routingKey: string, content: Buffer, options: PublishOptions): Promise<void>;
  /** Declares the queue + retry queues + DLQ and starts consuming with manual acks. */
  consume(
    spec: ConsumerSpec,
    handler: (message: ReceivedMessage) => Promise<ConsumeResult>,
    onDeadLetter: (info: DeadLetterInfo) => void,
  ): Promise<void>;
  /** Stops consuming (in-flight handlers finish), then closes all channels and the connection. */
  close(): Promise<void>;
}
