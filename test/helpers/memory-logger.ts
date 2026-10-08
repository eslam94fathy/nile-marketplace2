import { JsonLogger, type ILogWriter } from '../../src/lib/logger';

/** Captures JSON log lines so tests can assert on them. */
export class MemoryLogWriter implements ILogWriter {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  entries(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  clear(): void {
    this.lines.length = 0;
  }
}

export function createMemoryLogger(): { logger: JsonLogger; writer: MemoryLogWriter } {
  const writer = new MemoryLogWriter();
  const logger = new JsonLogger({
    level: 'debug',
    service: 'nile-test',
    env: 'test',
    writer,
    clock: { now: () => new Date() },
  });
  return { logger, writer };
}
