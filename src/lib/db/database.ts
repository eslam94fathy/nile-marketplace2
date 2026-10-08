import knexFactory, { type Knex } from 'knex';
import { type Env } from '../config';

export type DbTransaction = Knex.Transaction;
/** Either the root connection or a transaction: repositories use `(trx ?? this.db)` (CLAUDE.md §3). */
export type DbExecutor = Knex | Knex.Transaction;

export interface IDatabase {
  readonly knex: Knex;
  /** `SELECT 1` for health checks (G8). */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface ITransactionRunner {
  /** Runs `work` in one transaction: commit on resolve, rollback on throw. */
  run<T>(work: (trx: DbTransaction) => Promise<T>): Promise<T>;
}

type DbEnv = Pick<
  Env,
  'DATABASE_URL' | 'DB_SSL' | 'DB_POOL_MIN' | 'DB_POOL_MAX' | 'DB_STATEMENT_TIMEOUT_MS' | 'SERVICE_NAME'
>;

export function createKnex(env: DbEnv): Knex {
  return knexFactory({
    client: 'pg',
    connection: {
      connectionString: env.DATABASE_URL,
      // RDS: the CA bundle is supplied to Node via NODE_EXTRA_CA_CERTS at deploy time.
      ssl: env.DB_SSL ? { rejectUnauthorized: true } : false,
      statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
      application_name: env.SERVICE_NAME,
    },
    pool: { min: env.DB_POOL_MIN, max: env.DB_POOL_MAX },
  });
}

export class Database implements IDatabase, ITransactionRunner {
  constructor(readonly knex: Knex) {}

  async ping(): Promise<void> {
    await this.knex.raw('SELECT 1');
  }

  run<T>(work: (trx: DbTransaction) => Promise<T>): Promise<T> {
    return this.knex.transaction(work);
  }

  async close(): Promise<void> {
    await this.knex.destroy();
  }
}
