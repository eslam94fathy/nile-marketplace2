import { connect, type Channel, type ChannelModel } from 'amqplib';

/**
 * A raw AMQP client for tests: binds an exclusive queue to see what was published,
 * publishes hand-made messages, and inspects queue depths (e.g. the DLQ).
 */
export class AmqpProbe {
  private constructor(
    private readonly connection: ChannelModel,
    readonly channel: Channel,
  ) {}

  static async open(url: string): Promise<AmqpProbe> {
    const connection = await connect(url);
    const channel = await connection.createChannel();
    return new AmqpProbe(connection, channel);
  }

  /** Exclusive queue bound to `exchange` with `pattern`; returns its name. */
  async tap(exchange: string, pattern = '#'): Promise<string> {
    await this.channel.assertExchange(exchange, 'topic', { durable: true });
    const { queue } = await this.channel.assertQueue('', { exclusive: true });
    await this.channel.bindQueue(queue, exchange, pattern);
    return queue;
  }

  /** Reads every message currently in the queue (acks them). */
  async drain(queue: string): Promise<{ content: Record<string, unknown>; messageId: string | undefined }[]> {
    const out: { content: Record<string, unknown>; messageId: string | undefined }[] = [];
    for (;;) {
      const message = await this.channel.get(queue, { noAck: true });
      if (message === false) return out;
      out.push({
        content: JSON.parse(message.content.toString('utf8')) as Record<string, unknown>,
        messageId: message.properties.messageId as string | undefined,
      });
    }
  }

  async messageCount(queue: string): Promise<number> {
    return (await this.channel.checkQueue(queue)).messageCount;
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

/** Polls until `check` returns true (or fails after `timeoutMs`). */
export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
