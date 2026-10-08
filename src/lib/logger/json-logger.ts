import { getContext } from '../context';
import { type IClock } from '../clock';
import { type ILogger, type ILogWriter, type LogFields } from './logger.interface';
import { sanitizeFields } from './serialize';

export const LogLevel = { fatal: 60, error: 50, warn: 40, info: 30, debug: 20 } as const;
export type LogLevelKey = keyof typeof LogLevel;

/** Field names reserved for the envelope; caller fields with these names are moved under `fields`. */
const RESERVED = new Set(['level', 'timestamp', 'message', 'service', 'env', 'correlationId']);

export interface JsonLoggerOptions {
  level: LogLevelKey;
  service: string;
  env: string;
  writer: ILogWriter;
  clock: IClock;
}

/** Structured JSON logger: one event per line (CLAUDE.md §9.2). */
export class JsonLogger implements ILogger {
  private readonly threshold: number;

  constructor(
    private readonly options: JsonLoggerOptions,
    private readonly bindings: LogFields = {},
  ) {
    this.threshold = LogLevel[options.level];
  }

  fatal(message: string, fields?: LogFields): void {
    this.log('fatal', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.log('error', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.log('warn', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log('info', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.log('debug', message, fields);
  }

  child(bindings: LogFields): ILogger {
    return new JsonLogger(this.options, { ...this.bindings, ...bindings });
  }

  private log(level: LogLevelKey, message: string, fields: LogFields | undefined): void {
    if (LogLevel[level] < this.threshold) return;

    const context = getContext();
    const data = sanitizeFields({ ...this.bindings, ...fields });
    const extra: Record<string, unknown> = {};
    const clashing: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (RESERVED.has(key)) clashing[key] = value;
      else extra[key] = value;
    }

    const line: Record<string, unknown> = {
      level,
      timestamp: this.options.clock.now().toISOString(),
      message,
      service: this.options.service,
      env: this.options.env,
      ...(context ? { correlationId: context.correlationId } : {}),
      ...(context?.userId && extra.userId === undefined ? { userId: context.userId } : {}),
      ...extra,
      ...(Object.keys(clashing).length > 0 ? { fields: clashing } : {}),
    };

    try {
      this.options.writer.write(JSON.stringify(line));
    } catch {
      // A logger must never crash the process; fall back to a minimal line.
      this.options.writer.write(
        JSON.stringify({
          level,
          timestamp: line.timestamp,
          message,
          service: this.options.service,
          logError: true,
        }),
      );
    }
  }
}
