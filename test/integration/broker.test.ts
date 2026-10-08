import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RabbitMqBroker } from '../../src/pkg/messaging';
import { createTestResources, type TestResources } from '../helpers/test-resources';

describe('RabbitMqBroker lifecycle', () => {
  let resources: TestResources;

  beforeAll(async () => {
    resources = await createTestResources();
  });
  afterAll(async () => {
    await resources.cleanup();
  });

  // Regression: connect() used to resolve before the publisher channel finished opening, and an
  // immediate close() made amqplib reject an internal reply nobody awaited (unhandled rejection).
  it.each(['connect → close', 'connect → assertExchange → close', 'connect → publish → close'])(
    '%s leaves no unhandled rejection',
    async (scenario) => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', listener);
      try {
        const broker = new RabbitMqBroker({
          url: resources.env.RABBITMQ_URL,
          heartbeatSeconds: 30,
          publishTimeoutMs: 2_000,
        });
        await broker.connect(5_000);
        expect(broker.isConnected()).toBe(true);
        if (scenario.includes('assertExchange') || scenario.includes('publish')) {
          await broker.assertExchange('nile.events');
        }
        if (scenario.includes('publish')) {
          await broker.publish('nile.events', 'test.event', Buffer.from('{}'), {
            messageId: 'm-1',
            contentType: 'application/json',
          });
        }
        await broker.close();
        expect(broker.isConnected()).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 300));
      } finally {
        process.off('unhandledRejection', listener);
      }
      expect(unhandled.map(String)).toEqual([]);
    },
  );
});
