import { type NamedMigration } from '../lib/db/migration-source';
import * as m20261008000001 from './20261008000001_enable_pg_trgm';
import * as m20261008000002 from './20261008000002_create_events_outbox';
import * as m20261008000003 from './20261008000003_create_processed_events';
import * as m20261008123200 from './20261008123200_create_users';
import * as m20261008123202 from './20261008123202_create_refresh_tokens';
import * as m20261008123204 from './20261008123204_create_verification_codes';
// <migration-imports> (npm run migrate:make appends above this line)

/** Every migration, in timestamp order. Never edit or reorder an applied one (CLAUDE.md §6.1). */
export const MIGRATIONS: readonly NamedMigration[] = [
  { name: '20261008000001_enable_pg_trgm', module: m20261008000001 },
  { name: '20261008000002_create_events_outbox', module: m20261008000002 },
  { name: '20261008000003_create_processed_events', module: m20261008000003 },
  { name: '20261008123200_create_users', module: m20261008123200 },
  { name: '20261008123202_create_refresh_tokens', module: m20261008123202 },
  { name: '20261008123204_create_verification_codes', module: m20261008123204 },
  // <migration-list> (npm run migrate:make appends above this line)
];
