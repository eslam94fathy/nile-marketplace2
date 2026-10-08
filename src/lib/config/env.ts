import { envSchema, type Env } from './env.schema';

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';

  /** Only key names and rule messages: values are never included (CLAUDE.md §4). */
  constructor(readonly invalidKeys: readonly { key: string; problem: string }[]) {
    super(`Invalid environment: ${invalidKeys.map((issue) => issue.key).join(', ')}`);
  }
}

/** Parses and freezes the environment. Pure: tests pass their own record. */
export function loadEnv(raw: Readonly<Record<string, string | undefined>>): Readonly<Env> {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // One entry per key (a key can fail several rules); the first problem is enough to fix it.
    const byKey = new Map<string, string>();
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '(root)';
      if (!byKey.has(key)) byKey.set(key, issue.message);
    }
    throw new EnvValidationError([...byKey].map(([key, problem]) => ({ key, problem })));
  }
  if (result.data.PAGINATION_DEFAULT_LIMIT > result.data.PAGINATION_MAX_LIMIT) {
    throw new EnvValidationError([
      { key: 'PAGINATION_DEFAULT_LIMIT', problem: 'must be <= PAGINATION_MAX_LIMIT' },
    ]);
  }
  if (result.data.DB_POOL_MIN > result.data.DB_POOL_MAX) {
    throw new EnvValidationError([{ key: 'DB_POOL_MIN', problem: 'must be <= DB_POOL_MAX' }]);
  }
  return Object.freeze(result.data);
}

/** The only place that reads process.env. Called once by each entrypoint. */
export function loadEnvFromProcess(): Readonly<Env> {
  return loadEnv(process.env);
}
