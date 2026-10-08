import { type Knex } from 'knex';

export interface MigrationModule {
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
  /** `{ transaction: false }` for CREATE INDEX CONCURRENTLY (CLAUDE.md §6.1). */
  config?: { transaction?: boolean };
}

export interface NamedMigration {
  name: string;
  module: MigrationModule;
}

/**
 * Feeds Knex an explicit, ordered list of migrations instead of scanning a directory,
 * so the same code works compiled (node) and from source (Vitest).
 */
export class ListMigrationSource implements Knex.MigrationSource<NamedMigration> {
  constructor(private readonly migrations: readonly NamedMigration[]) {
    const names = migrations.map((migration) => migration.name);
    const sorted = [...names].sort();
    if (names.some((name, index) => name !== sorted[index])) {
      throw new Error('Migrations must be listed in timestamp order');
    }
    if (new Set(names).size !== names.length) throw new Error('Duplicate migration name');
  }

  getMigrations(): Promise<NamedMigration[]> {
    return Promise.resolve([...this.migrations]);
  }

  getMigrationName(migration: NamedMigration): string {
    return migration.name;
  }

  getMigration(migration: NamedMigration): Promise<Knex.Migration> {
    return Promise.resolve(migration.module);
  }
}
