import { type DbTransaction } from './database';

/**
 * Runs `effect` once `trx` has committed, never after a rollback. For side effects outside the
 * database (Redis) that must not happen for a change that didn't stick. The effect handles its own
 * errors: nobody awaits it.
 */
export function afterCommit(trx: DbTransaction, effect: () => Promise<void>): void {
  trx.executionPromise.then(
    () => effect(),
    () => undefined,
  );
}
