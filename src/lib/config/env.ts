import { type z } from 'zod';

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';

  /** Only key names and rule messages: values are never included (CLAUDE.md §4). */
  constructor(readonly invalidKeys: readonly { key: string; problem: string }[]) {
    super(`Invalid environment: ${invalidKeys.map((issue) => issue.key).join(', ')}`);
  }
}

/** Parses and freezes the environment for one process. Pure: tests pass their own record. */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  raw: Readonly<Record<string, string | undefined>>,
): Readonly<z.output<S>> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    // One entry per key (a key can fail several rules); the first problem is enough to fix it.
    const byKey = new Map<string, string>();
    for (const issue of result.error.issues) {
      // Report the env var itself, not a nested path (e.g. MQ_RETRY_DELAYS_MS, not MQ_RETRY_DELAYS_MS.1).
      const key = issue.path.length > 0 ? String(issue.path[0]) : '(root)';
      if (!byKey.has(key)) byKey.set(key, issue.message);
    }
    throw new EnvValidationError([...byKey].map(([key, problem]) => ({ key, problem })));
  }
  return Object.freeze(result.data);
}

/** The only place that reads process.env. Called once by each entrypoint. */
export function loadEnvFromProcess<S extends z.ZodType>(schema: S): Readonly<z.output<S>> {
  return loadEnv(schema, process.env);
}
