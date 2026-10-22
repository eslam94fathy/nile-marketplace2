import { describe, expect, it } from 'vitest';
import { displayNameOf } from '../service/customer-directory.service';

describe('displayNameOf (spec 04 §8.3, RV-6)', () => {
  it('is the first name and the last initial, upper-cased, with a dot', () => {
    expect(displayNameOf('Mona', 'Ali')).toBe('Mona A.');
    expect(displayNameOf('mona', 'ali')).toBe('mona A.');
    expect(displayNameOf('  Mona ', '  ali')).toBe('Mona A.');
  });

  it('keeps a non-Latin initial whole', () => {
    expect(displayNameOf('منى', 'علي')).toBe('منى ع.');
    expect(displayNameOf('Mona', '𝒜li')).toBe('Mona 𝒜.');
  });
});
