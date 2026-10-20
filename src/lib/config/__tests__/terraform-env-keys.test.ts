import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiEnvSchema, seedAdminEnvSchema, workerEnvSchema } from '..';

/** infra/terraform/modules/environment/env-keys.json (plan §10, P8-Q10). */
interface EnvKeys {
  common: string[];
  database: string[];
  api: string[];
  worker: string[];
  migrate: string[];
  derived: Record<'common' | 'database' | 'api' | 'worker' | 'migrate', string[]>;
  secrets: Record<'api' | 'worker' | 'migrate', string[]>;
  manual_secrets: string[];
}

const envKeys = JSON.parse(
  readFileSync(join(__dirname, '../../../../infra/terraform/modules/environment/env-keys.json'), 'utf8'),
) as EnvKeys;

/** Keys a deployed environment never sets: local development only (refused in staging / production). */
const DEV_ONLY = new Set([
  'MAILPIT_URL',
  'STORAGE_ENDPOINT',
  'STORAGE_PUBLIC_ENDPOINT',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
]);

function deployedKeys(process: 'api' | 'worker' | 'migrate'): string[] {
  const { derived, secrets } = envKeys;
  return [
    ...envKeys.common,
    ...envKeys.database,
    ...envKeys[process],
    ...derived.common,
    ...derived.database,
    ...derived[process],
    ...secrets[process],
  ].sort();
}

const schemaKeys = (schema: { shape: Record<string, unknown> }) =>
  Object.keys(schema.shape)
    .filter((key) => !DEV_ONLY.has(key))
    .sort();

/*
 * The ECS task definitions are built from env-keys.json: a key added to an env schema and not there
 * would be missing in AWS (and the process would refuse to start), so the two must agree.
 */
describe('Terraform env keys match the env schemas', () => {
  it.each([
    ['api', apiEnvSchema],
    ['worker', workerEnvSchema],
    // The migrate task also runs seed-admin, whose schema is a superset of migrate's.
    ['migrate', seedAdminEnvSchema],
  ] as const)('%s: every key exactly once, nothing extra', (process, schema) => {
    const keys = deployedKeys(process);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
    expect(keys).toEqual(schemaKeys(schema));
  });

  it('every secret a process reads exists, and the hand-filled ones are the non-generated ones', () => {
    const generated = ['DATABASE_URL', 'REDIS_URL', 'RABBITMQ_URL'];
    const all = new Set([...generated, ...envKeys.manual_secrets]);
    for (const list of Object.values(envKeys.secrets)) {
      for (const key of list) expect(all.has(key), key).toBe(true);
    }
    expect(envKeys.manual_secrets.filter((key) => generated.includes(key))).toEqual([]);
  });
});
