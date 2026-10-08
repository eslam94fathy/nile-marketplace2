import {
  type ApiInfrastructure,
  closeInfrastructure,
  createApiInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { createMemoryLogger, type MemoryLogWriter } from './memory-logger';
import { createTestResources, type TestResources } from './test-resources';

export interface TestInfra<I> {
  infra: I;
  logs: MemoryLogWriter;
  resources: TestResources;
  close(): Promise<void>;
}

/** Real api infrastructure (Postgres/Redis/RabbitMQ) on this test file's isolated resources. */
export async function startTestInfra(
  envOverrides: Record<string, string> = {},
): Promise<TestInfra<ApiInfrastructure>> {
  const resources = await createTestResources(envOverrides);
  const { logger, writer } = createMemoryLogger();
  const infra = await createApiInfrastructure(resources.env, logger);
  return { infra, logs: writer, resources, close: () => closeAndCleanup(infra, resources) };
}

/** Real worker infrastructure (Postgres/RabbitMQ) on this test file's isolated resources. */
export async function startTestWorkerInfra(
  envOverrides: Record<string, string> = {},
): Promise<TestInfra<WorkerInfrastructure>> {
  const resources = await createTestResources(envOverrides);
  const { logger, writer } = createMemoryLogger();
  const infra = await createWorkerInfrastructure(resources.workerEnv, logger);
  return { infra, logs: writer, resources, close: () => closeAndCleanup(infra, resources) };
}

async function closeAndCleanup(
  infra: ApiInfrastructure | WorkerInfrastructure,
  resources: TestResources,
): Promise<void> {
  await closeInfrastructure(infra);
  await resources.cleanup();
}
