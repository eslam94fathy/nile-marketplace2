import { randomUUID } from 'node:crypto';
import knex from 'knex';
import { inject } from 'vitest';
import {
  type ApiEnv,
  apiEnvSchema,
  loadEnv,
  type SeedAdminEnv,
  seedAdminEnvSchema,
  type WorkerEnv,
  workerEnvSchema,
  type RealtimeEnv,
  realtimeEnvSchema,
} from '../../src/lib/config';
import { testEnvInput } from './test-env';
import { createTestBucket, TEST_STORAGE_REGION } from './test-storage';

const RABBIT_AUTH = `Basic ${Buffer.from('guest:guest').toString('base64')}`;
const TEMPLATE_DB = 'nile_template';
const PG_OBJECT_IN_USE = '55006';

export interface TestResources {
  /** Same resources, seen by each process. */
  env: Readonly<ApiEnv>;
  workerEnv: Readonly<WorkerEnv>;
  realtimeEnv: Readonly<RealtimeEnv>;
  seedAdminEnv: Readonly<SeedAdminEnv>;
  /** The raw key/values, e.g. to pass to a child process. */
  rawEnv: Record<string, string>;
  id: string;
  cleanup(): Promise<void>;
}

async function rabbitApi(method: 'PUT' | 'DELETE', path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${inject('rabbitManagementUrl')}/api${path}`, {
    method,
    headers: { Authorization: RABBIT_AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
    throw new Error(`RabbitMQ management ${method} ${path} failed: ${res.status}`);
  }
}

async function createDatabaseFromTemplate(database: string): Promise<void> {
  const admin = knex({ client: 'pg', connection: inject('pgAdminUrl') });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await admin.raw(`CREATE DATABASE ${database} TEMPLATE ${TEMPLATE_DB}`);
        return;
      } catch (error) {
        // Another file is cloning the template at the same moment: retry shortly.
        if ((error as { code?: string }).code !== PG_OBJECT_IN_USE || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
      }
    }
  } finally {
    await admin.destroy();
  }
}

/**
 * Isolated resources for ONE test file (P0-Q9): its own database (cloned from the migrated template),
 * Redis key prefix, RabbitMQ vhost and MinIO bucket. Returns a complete, validated env pointing at them.
 */
export async function createTestResources(overrides: Record<string, string> = {}): Promise<TestResources> {
  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  const database = `test_${id}`;
  const vhost = `test_${id}`;

  await createDatabaseFromTemplate(database);
  await rabbitApi('PUT', `/vhosts/${vhost}`);
  await rabbitApi('PUT', `/permissions/${vhost}/guest`, { configure: '.*', write: '.*', read: '.*' });
  const bucket = await createTestBucket();
  const storageEndpoint = inject('storageEndpoint');

  const databaseUrl = new URL(inject('pgAdminUrl'));
  databaseUrl.pathname = `/${database}`;
  const amqpUrl = new URL(inject('amqpBaseUrl'));
  amqpUrl.pathname = `/${vhost}`;

  const rawEnv = testEnvInput({
    DATABASE_URL: databaseUrl.toString(),
    REDIS_URL: inject('redisUrl'),
    REDIS_KEY_PREFIX: `t:${id}:`,
    RABBITMQ_URL: amqpUrl.toString(),
    STORAGE_BUCKET: bucket.bucket,
    STORAGE_REGION: TEST_STORAGE_REGION,
    STORAGE_ENDPOINT: storageEndpoint,
    STORAGE_PUBLIC_ENDPOINT: storageEndpoint,
    STORAGE_ACCESS_KEY_ID: inject('storageAccessKeyId'),
    STORAGE_SECRET_ACCESS_KEY: inject('storageSecretAccessKey'),
    MEDIA_PUBLIC_BASE_URL: `${storageEndpoint}/${bucket.bucket}`,
    ...overrides,
  });

  return {
    env: loadEnv(apiEnvSchema, rawEnv),
    workerEnv: loadEnv(workerEnvSchema, rawEnv),
    realtimeEnv: loadEnv(realtimeEnvSchema, rawEnv),
    seedAdminEnv: loadEnv(seedAdminEnvSchema, rawEnv),
    rawEnv,
    id,
    cleanup: async () => {
      const admin = knex({ client: 'pg', connection: inject('pgAdminUrl') });
      try {
        await admin.raw(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      } finally {
        await admin.destroy();
      }
      await rabbitApi('DELETE', `/vhosts/${vhost}`);
      await bucket.cleanup();
    },
  };
}
