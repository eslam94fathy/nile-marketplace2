import { type NamedMigration } from '../lib/db/migration-source';
import * as m20261008000001 from './20261008000001_enable_pg_trgm';
import * as m20261008000002 from './20261008000002_create_events_outbox';
import * as m20261008000003 from './20261008000003_create_processed_events';
// <migration-imports> (npm run migrate:make appends above this line)

/** Every migration, in timestamp order. Never edit or reorder an applied one (CLAUDE.md §6.1). */
export const MIGRATIONS: readonly NamedMigration[] = [
  { name: '20261008000001_enable_pg_trgm', module: m20261008000001 },
  { name: '20261008000002_create_events_outbox', module: m20261008000002 },
  { name: '20261008000003_create_processed_events', module: m20261008000003 },
  // <migration-list> (npm run migrate:make appends above this line)
];
