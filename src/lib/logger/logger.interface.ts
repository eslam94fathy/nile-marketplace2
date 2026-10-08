export type LogFields = Readonly<Record<string, unknown>>;

/** The only logging API application code uses (CLAUDE.md §9.2). Put data in fields, not in the message. */
export interface ILogger {
  fatal(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** A logger whose lines all carry `bindings` (e.g. `{ module: 'catalog' }`). */
  child(bindings: LogFields): ILogger;
}

export interface ILogWriter {
  write(line: string): void;
}
