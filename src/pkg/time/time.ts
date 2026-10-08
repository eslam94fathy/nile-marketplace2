export enum TimeUnit {
  MILLISECOND = 'millisecond',
  SECOND = 'second',
  MINUTE = 'minute',
  HOUR = 'hour',
  DAY = 'day',
}

const MS_PER_UNIT: Readonly<Record<TimeUnit, number>> = {
  [TimeUnit.MILLISECOND]: 1,
  [TimeUnit.SECOND]: 1_000,
  [TimeUnit.MINUTE]: 60_000,
  [TimeUnit.HOUR]: 3_600_000,
  [TimeUnit.DAY]: 86_400_000,
};

function assertFinite(value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Duration must be a finite number, got ${String(value)}`);
  }
}

export function toMs(value: number, unit: TimeUnit): number {
  assertFinite(value);
  return value * MS_PER_UNIT[unit];
}

/** Whole seconds (rounded down), e.g. for Redis TTLs. */
export function toSeconds(value: number, unit: TimeUnit): number {
  return Math.floor(toMs(value, unit) / MS_PER_UNIT[TimeUnit.SECOND]);
}

export function addDuration(date: Date, value: number, unit: TimeUnit): Date {
  return new Date(date.getTime() + toMs(value, unit));
}
