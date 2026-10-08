import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request / per-job context. Logs read it automatically (CLAUDE.md §9.2, G26). */
export interface ExecutionContext {
  readonly correlationId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<ExecutionContext>();

export function runWithContext<T>(context: ExecutionContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): ExecutionContext | undefined {
  return storage.getStore();
}

/** Set by the auth guard once the token is verified. No-op outside a context. */
export function setContextUserId(userId: string): void {
  const context = storage.getStore();
  if (context) context.userId = userId;
}
