import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import knex from 'knex';
import { type TestProject } from 'vitest/node';
import { migrateLatest } from '../../src/lib/db/migrator';
import { MIGRATIONS } from '../../src/migrations';

/** Image versions used by integration tests (keep in step with docker-compose.yml). */
export const TEST_IMAGES = {
  postgres: 'postgres:18',
  redis: 'redis:7.2-alpine',
  rabbitmq: 'rabbitmq:3.13-management',
} as const;

export const TEMPLATE_DB = 'nile_template';
const RABBIT_MANAGEMENT_PORT = 15672;

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplateUrl: string;
    redisUrl: string;
    amqpBaseUrl: string;
    rabbitManagementUrl: string;
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * One container set per test run (P0-Q9). Migrations run once into a template DB;
 * every test file then clones it (test/helpers/test-resources.ts).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [pg, redis, rabbit]: [StartedPostgreSqlContainer, StartedRedisContainer, StartedRabbitMQContainer] =
    await Promise.all([
      new PostgreSqlContainer(TEST_IMAGES.postgres)
        .withUsername('nile')
        .withPassword('nile')
        .withDatabase('nile_admin')
        .start(),
      new RedisContainer(TEST_IMAGES.redis).start(),
      new RabbitMQContainer(TEST_IMAGES.rabbitmq).start(),
    ]);

  const adminUrl = pg.getConnectionUri();
  const templateUrl = withDatabase(adminUrl, TEMPLATE_DB);
  const admin = knex({ client: 'pg', connection: adminUrl });
  await admin.raw(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.destroy();
  const template = knex({ client: 'pg', connection: templateUrl });
  await migrateLatest(template, MIGRATIONS);
  await template.destroy();

  project.provide('pgAdminUrl', adminUrl);
  project.provide('pgTemplateUrl', templateUrl);
  project.provide('redisUrl', redis.getConnectionUrl());
  project.provide('amqpBaseUrl', rabbit.getAmqpUrl());
  project.provide(
    'rabbitManagementUrl',
    `http://${rabbit.getHost()}:${rabbit.getMappedPort(RABBIT_MANAGEMENT_PORT)}`,
  );

  return async () => {
    await Promise.allSettled([pg.stop(), redis.stop(), rabbit.stop()]);
  };
}
