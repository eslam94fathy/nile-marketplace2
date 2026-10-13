import { describe, expect, it } from 'vitest';
import { addDuration, TimeUnit, toMs, toSeconds } from '..';

describe('pkg/time', () => {
  it('converts units to milliseconds', () => {
    expect(toMs(15, TimeUnit.MINUTE)).toBe(900_000);
    expect(toMs(2, TimeUnit.DAY)).toBe(172_800_000);
    expect(toMs(250, TimeUnit.MILLISECOND)).toBe(250);
  });

  it('converts to whole seconds, rounding down', () => {
    expect(toSeconds(1, TimeUnit.HOUR)).toBe(3_600);
    expect(toSeconds(1_500, TimeUnit.MILLISECOND)).toBe(1);
  });

  it('adds a duration without mutating the input date', () => {
    const start = new Date('2026-10-08T10:00:00.000Z');
    expect(addDuration(start, 24, TimeUnit.HOUR).toISOString()).toBe('2026-10-09T10:00:00.000Z');
    expect(start.toISOString()).toBe('2026-10-08T10:00:00.000Z');
  });

  it('rejects non-finite durations', () => {
    expect(() => toMs(Number.NaN, TimeUnit.SECOND)).toThrow(RangeError);
    expect(() => toMs(Number.POSITIVE_INFINITY, TimeUnit.SECOND)).toThrow(RangeError);
  });
});
