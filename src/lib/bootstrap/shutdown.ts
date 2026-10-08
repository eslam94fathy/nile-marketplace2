import { type ILogger } from '../logger';

export interface ShutdownStep {
  name: string;
  run(): Promise<void>;
}

/**
 * Graceful shutdown (CLAUDE.md §11): steps run in order (stop intake → drain → close DB/Redis/broker).
 * Idempotent; a hard deadline guarantees the process exits even if a step hangs.
 */
export function createShutdown(
  logger: ILogger,
  timeoutMs: number,
  steps: readonly ShutdownStep[],
): (reason: string, exitCode: number) => Promise<void> {
  let started = false;
  return async (reason, exitCode) => {
    if (started) return;
    started = true;
    logger.info('shutdown started', { reason, timeoutMs });

    const deadline = setTimeout(() => {
      logger.error('shutdown timed out, exiting', { reason, timeoutMs });
      process.exit(exitCode === 0 ? 1 : exitCode);
    }, timeoutMs);
    deadline.unref();

    for (const step of steps) {
      try {
        await step.run();
      } catch (error) {
        logger.error('shutdown step failed', { step: step.name, error });
      }
    }
    clearTimeout(deadline);
    logger.info('shutdown complete', { reason });
    process.exit(exitCode);
  };
}

/** CLAUDE.md §9.1: log at fatal and shut down gracefully. */
export function installProcessHandlers(
  logger: ILogger,
  shutdown: (reason: string, exitCode: number) => Promise<void>,
): void {
  process.on('unhandledRejection', (reason) => {
    logger.fatal('unhandled promise rejection', { error: reason });
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal('uncaught exception', { error });
    void shutdown('uncaughtException', 1);
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
}
