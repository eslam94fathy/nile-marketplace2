import { type ILogWriter } from './logger.interface';

/** The single place allowed to write to stdout (Docker collects it). */
export class StdoutLogWriter implements ILogWriter {
  write(line: string): void {
    process.stdout.write(`${line}\n`);
  }
}
