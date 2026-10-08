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
    ]);
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
