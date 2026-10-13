import { type Express, type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { createApiContainer } from '../../src/container';
import { createApp } from '../../src/http-app';
import { type ApiInfrastructure } from '../../src/infrastructure';
import { type MemoryLogWriter } from './memory-logger';
import { startTestInfra } from './test-infra';
import { type TestResources } from './test-resources';

export interface TestApp {
  app: Express;
  infra: ApiInfrastructure;
  container: DependencyContainer;
  logs: MemoryLogWriter;
  resources: TestResources;
  close(): Promise<void>;
}

export interface TestAppOptions {
  envOverrides?: Record<string, string>;
  /** Test-only routers (never mounted by server.ts), built once infrastructure exists. */
  extraRouters?: (infra: ApiInfrastructure) => readonly { path: string; router: Router }[];
}

/** A full app (real Postgres/Redis/RabbitMQ) on this file's isolated resources. */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const testInfra = await startTestInfra(options.envOverrides);
  const { infra, logs, resources } = testInfra;
  const container = createApiContainer(infra);
  const app = createApp(infra, container, { extraRouters: options.extraRouters?.(infra) ?? [] });
  return { app, infra, container, logs, resources, close: () => testInfra.close() };
}
