import { type Express, type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http-app';
import { closeInfrastructure, createInfrastructure, type Infrastructure } from '../../src/infrastructure';
import { createMemoryLogger, type MemoryLogWriter } from './memory-logger';
import { createTestResources, type TestResources } from './test-resources';

export interface TestApp {
  app: Express;
  infra: Infrastructure;
  container: DependencyContainer;
  logs: MemoryLogWriter;
  resources: TestResources;
  close(): Promise<void>;
}

export interface TestAppOptions {
  envOverrides?: Record<string, string>;
  /** Test-only routers (never mounted by server.ts), built once infrastructure exists. */
  extraRouters?: (infra: Infrastructure) => readonly { path: string; router: Router }[];
}

/** A full app (real Postgres/Redis/RabbitMQ) on this file's isolated resources. */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const resources = await createTestResources(options.envOverrides);
  const { logger, writer } = createMemoryLogger();
  const infra = await createInfrastructure(resources.env, logger);
  const container = createContainer(infra);
  const app = createApp(infra, container, { extraRouters: options.extraRouters?.(infra) ?? [] });
  return {
    app,
    infra,
    container,
    logs: writer,
    resources,
    close: async () => {
      await closeInfrastructure(infra);
      await resources.cleanup();
    },
  };
}
