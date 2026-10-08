import { SystemClock } from '../clock';
import { type Env, EnvValidationError, loadEnvFromProcess } from '../config';
import { type ILogger, JsonLogger, StdoutLogWriter } from '../logger';

/**
 * Loads the environment or exits with a fatal log naming the bad keys (never their values, CLAUDE.md §4).
 * `serviceName` is used for this single log line only, because SERVICE_NAME itself may be the bad key.
 */
export function loadEnvOrExit(serviceName: string): Readonly<Env> {
  try {
    return loadEnvFromProcess();
  } catch (error) {
    const logger = new JsonLogger({
      level: 'fatal',
      service: serviceName,
      env: 'unknown',
      writer: new StdoutLogWriter(),
      clock: new SystemClock(),
    });
    if (error instanceof EnvValidationError) {
      logger.fatal('invalid environment configuration', { invalidKeys: error.invalidKeys });
    } else {
      logger.fatal('failed to load environment configuration', { error });
    }
    process.exit(1);
  }
}

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'SERVICE_NAME' | 'NODE_ENV'>): ILogger {
  return new JsonLogger({
    level: env.LOG_LEVEL,
    service: env.SERVICE_NAME,
    env: env.NODE_ENV,
    writer: new StdoutLogWriter(),
    clock: new SystemClock(),
  });
}
