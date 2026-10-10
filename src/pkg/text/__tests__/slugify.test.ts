import { describe, expect, it } from 'vitest';
import { slugify } from '..';

describe('pkg/text slugify', () => {
  it.each([
    ['Men’s Shoes', 'men-s-shoes'],
    ['  Laptops & Tablets  ', 'laptops-tablets'],
    ['Café Crème', 'cafe-creme'],
    ['TV--4K', 'tv-4k'],
    ['!!!', ''],
    ['هواتف', ''],
  ])('%s → %s', (input, expected) => {
    expect(slugify(input, 120)).toBe(expected);
  });

  it('cuts to maxLength without leaving a trailing dash', () => {
    expect(slugify('abc def', 4)).toBe('abc');
    expect(slugify('abcdef', 3)).toBe('abc');
  });

  it('rejects a bad maxLength', () => {
    expect(() => slugify('a', 0)).toThrow(RangeError);
  });
});
