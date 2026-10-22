import { describe, expect, it } from 'vitest';
import { ratingDelta } from '../service/rating-aggregates.service';

describe('ratingDelta (spec 17 §1.2)', () => {
  it('counts a review that starts or stops counting, or moves between ratings', () => {
    expect(ratingDelta({ add: 4 })).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 });
    expect(ratingDelta({ remove: 2 })).toEqual({ 1: 0, 2: -1, 3: 0, 4: 0, 5: 0 });
    expect(ratingDelta({ add: 5, remove: 2 })).toEqual({ 1: 0, 2: -1, 3: 0, 4: 0, 5: 1 });
    expect(ratingDelta({ add: 3, remove: 3 })).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  });
});
