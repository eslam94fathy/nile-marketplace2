import { describe, expect, it } from 'vitest';
import { parseIdOrSlug } from '../dto/product-public.dto';

describe('parseIdOrSlug (spec 06 §4.1)', () => {
  it('a UUID v7 is an id (lower-cased); anything slug-shaped is a slug', () => {
    expect(parseIdOrSlug('01920D3E-7A1C-7C2B-9A4E-3F0C2D1B6A55')).toEqual({
      id: '01920d3e-7a1c-7c2b-9a4e-3f0c2d1b6a55',
    });
    expect(parseIdOrSlug('smart-phone-x-a1b2c3')).toEqual({ slug: 'smart-phone-x-a1b2c3' });
    // A v4 UUID is not an id here; it is still slug-shaped, so it simply won't match a product.
    expect(parseIdOrSlug('9b2e4c1a-3f5d-4e6b-8a7c-1d2e3f4a5b6c')).toEqual({
      slug: '9b2e4c1a-3f5d-4e6b-8a7c-1d2e3f4a5b6c',
    });
  });

  it.each(['Upper-Case', 'has space', '', `a${'-b'.repeat(120)}`, 'trailing-'])('rejects %j', (raw) => {
    expect(() => parseIdOrSlug(raw)).toThrow(/validation failed/i);
  });
});
