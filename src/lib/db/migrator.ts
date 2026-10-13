import { type Knex } from 'knex';
import { ListMigrationSource, type NamedMigration } from './migration-source';

export const MIGRATIONS_TABLE = 'knex_migrations';

function config(migrations: readonly NamedMigration[]): Knex.MigratorConfig {
  return { migrationSource: new ListMigrationSource(migrations), tableName: MIGRATIONS_TABLE };
}

export async function migrateLatest(knex: Knex, migrations: readonly NamedMigration[]): Promise<string[]> {
  const [, applied] = (await knex.migrate.latest(config(migrations))) as [number, string[]];
  return applied;
}

export async function migrateRollback(knex: Knex, migrations: readonly NamedMigration[]): Promise<string[]> {
  const [, reverted] = (await knex.migrate.rollback(config(migrations))) as [number, string[]];
  return reverted;
}

export async function migrateDownAll(knex: Knex, migrations: readonly NamedMigration[]): Promise<string[]> {
  const [, reverted] = (await knex.migrate.rollback(config(migrations), true)) as [number, string[]];
  return reverted;
}
