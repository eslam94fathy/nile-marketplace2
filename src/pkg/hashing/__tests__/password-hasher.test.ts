import { describe, expect, it } from 'vitest';
import { BcryptPasswordHasher } from '..';

describe('pkg/hashing BcryptPasswordHasher', () => {
  const hasher = new BcryptPasswordHasher(10);

  it('hashes with the configured cost and verifies', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$2b\$10\$/);
    expect(await hasher.verify('correct horse battery staple', hash)).toBe(true);
    expect(await hasher.verify('wrong', hash)).toBe(false);
  });

  it('salts: the same password hashes differently', async () => {
    expect(await hasher.hash('same')).not.toBe(await hasher.hash('same'));
  });

  it('enforces the 72-byte bcrypt limit (no silent truncation)', async () => {
    await expect(hasher.hash('é'.repeat(37))).rejects.toThrow(RangeError); // 74 bytes
    await expect(hasher.hash('')).rejects.toThrow(RangeError);
    const hash = await hasher.hash('a'.repeat(72));
    expect(await hasher.verify(`${'a'.repeat(72)}extra`, hash)).toBe(false);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    expect(await hasher.verify('x', 'not-a-hash')).toBe(false);
  });

  it('rejects a cost outside 10..15', () => {
    expect(() => new BcryptPasswordHasher(4)).toThrow(RangeError);
    expect(() => new BcryptPasswordHasher(16)).toThrow(RangeError);
  });
});
