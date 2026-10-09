import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ListMigrationSource, type MigrationModule } from '../../lib/db';
import { MIGRATIONS } from '..';

const noop: MigrationModule = { up: () => Promise.resolve(), down: () => Promise.resolve() };

describe('migrations list (ListMigrationSource)', () => {
  it('serves the registered migrations in order', async () => {
    const source = new ListMigrationSource(MIGRATIONS);
    const listed = await source.getMigrations();
    expect(listed.map((m) => source.getMigrationName(m))).toEqual([
      '20261008000001_enable_pg_trgm',
      '20261008000002_create_events_outbox',
      '20261008000003_create_processed_events',
      '20261008123200_create_users',
      '20261008123202_create_refresh_tokens',
      '20261008123204_create_verification_codes',
      '20261008134257_create_notification_log',
      '20261008135708_add_users_role_created_at_index',
      '20261009192351_create_governorates',
      '20261009192353_create_delivery_settings',
      '20261009194352_create_customers',
      '20261009194354_create_customer_addresses',
    ]);
  });

  it('every migration file in the folder is registered (no forgotten migration)', () => {
    const files = readdirSync(join(__dirname, '..'))
      .filter((file) => /^\d{14}_[a-z0-9_]+\.ts$/.test(file))
      .map((file) => file.replace(/\.ts$/, ''));
    expect(MIGRATIONS.map((m) => m.name)).toEqual(files.sort());
  });

  it('every migration has an up and a down', () => {
    for (const { name, module } of MIGRATIONS) {
      expect(typeof module.up, name).toBe('function');
      expect(typeof module.down, name).toBe('function');
    }
  });

  it('rejects out-of-order or duplicate names', () => {
    expect(
      () =>
        new ListMigrationSource([
          { name: '20261008000002_b', module: noop },
          { name: '20261008000001_a', module: noop },
        ]),
    ).toThrow(/timestamp order/);
    expect(
      () =>
        new ListMigrationSource([
          { name: '20261008000001_a', module: noop },
          { name: '20261008000001_a', module: noop },
        ]),
    ).toThrow(/Duplicate/);
  });
});
