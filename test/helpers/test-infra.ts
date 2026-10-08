import { closeInfrastructure, createInfrastructure, type Infrastructure } from '../../src/infrastructure';
import { createMemoryLogger, type MemoryLogWriter } from './memory-logger';
import { createTestResources, type TestResources } from './test-resources';

export interface TestInfra {
  infra: Infrastructure;
  logs: MemoryLogWriter;
  resources: TestResources;
  close(): Promise<void>;
}

/** Real infrastructure (Postgres/Redis/RabbitMQ) on this test file's isolated resources. */
export async function startTestInfra(envOverrides: Record<string, string> = {}): Promise<TestInfra> {
  const resources = await createTestResources(envOverrides);
  const { logger, writer } = createMemoryLogger();
  const infra = await createInfrastructure(resources.env, logger);
  return {
    infra,
    logs: writer,
    resources,
    close: async () => {
      await closeInfrastructure(infra);
      await resources.cleanup();
    },
  };
}
