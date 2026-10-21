import { describe, expect, it } from 'vitest';
import { ratingAverage } from '..';

describe('ratingAverage (spec 17 §1.2)', () => {
  it('rounds sum / count to 2 places, half up, as a string; null without ratings', () => {
    expect(ratingAverage(0, 0)).toBeNull();
    expect(ratingAverage(5, 1)).toBe('5.00');
    expect(ratingAverage(13, 3)).toBe('4.33');
    expect(ratingAverage(14, 3)).toBe('4.67');
    // 4.125 → 4.13: half up, not banker's rounding, and no float error.
    expect(ratingAverage(33, 8)).toBe('4.13');
    expect(ratingAverage(7, 4)).toBe('1.75');
  });
});
